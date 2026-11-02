/**
 * The browser tools for the in-tab worker — transport only.
 *
 * A worker cannot spawn Chrome, so these tools cannot be the app's Node
 * implementation. What they *can* be is the same code: the four verbs (names,
 * descriptions, schemas, bodies, cursor-listener confirmation) live once in
 * the workspace at `app/browser/src/verbs.js`, and this file binds that
 * factory to a browser-level CDP socket.
 *
 * The launcher (`npm run chrome`) starts Chrome with --remote-allow-origins
 * and passes the browser websocket in `?cdp=…`; tools connect there and work
 * over flat sessions:
 *
 *   Target.getTargets      instead of GET /json/list
 *   Target.createTarget    instead of PUT /json/new
 *   Target.attachToTarget  { flatten: true } -> a sessionId
 *   Runtime.evaluate / Runtime.callFunctionOn / DOMDebugger.getEventListeners
 *                          with that sessionId
 *
 * The workspace module is evaluated through the same loader app tools use, so
 * a deployed web build runs whatever `app/browser/src/verbs.js` it was seeded
 * with — no second copy to keep in step.
 */
import { BrowserCdp, isLoopbackPage, type CdpTarget } from "./cdp";
import { createModuleLoader } from "./module-loader";
import type { KatTool } from "./browser-tools";
import type { Platform } from "../platform/types";
import { AgentStoppedError, throwIfStopped } from "../stop-error";

const NOT_CONNECTED = isLoopbackPage()
  ? "browser tools are not connected. Run `npm run chrome` in the grandpa-bob repo and open " +
    "bob from the URL it prints (it adds ?cdp=…). If Chrome was already running on the debug " +
    "port, quit it and run `npm run chrome` again so it starts with --remote-allow-origins."
  : "browser tools are not connected. In the toolbar open Sync… → Connect browser… and run " +
    "the command it copies for your system, then reload this page. It starts a separate " +
    "Chrome with the automation port BOB needs.";

interface SessionPage {
  /** The attached tab's URL (null when unknown). */
  url: string | null;
  /** True when this call started Chrome; the worker never can, so always false. */
  launched: boolean;
  evaluate: (code: string) => Promise<unknown>;
  evaluateHandles: (expression: string) => Promise<string[]>;
  callFunction: (objectId: string, functionDeclaration: string) => Promise<unknown>;
  eventListenerTypes: (objectId: string) => Promise<string[]>;
}

/** The interface `app/browser/src/verbs.js` binds its bodies to. */
interface Session {
  profileHint: string;
  withPage<T>(fn: (page: SessionPage) => Promise<T>): Promise<T>;
}

interface VerbTool extends KatTool {
  name: string;
}

interface VerbsModule {
  makeTools(session: Session): VerbTool[];
}

/** A page call in flight, so a stop can clean up the tab it is using. */
interface PageCall {
  client: BrowserCdp;
  sessionId: string;
  /** True when BOB opened this tab (never the user's newest tab). */
  ownsTab: boolean;
  /** True while an evaluate/evaluateHandles request is on the wire. */
  evaluating: boolean;
  cleaning: Promise<void> | null;
}

/** Wait for a cleanup request, but never let a wedged tab hold the stop. */
function settleWithin(promise: Promise<unknown>, ms = 2_000): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

/**
 * What a stop does to a page call: terminate the injected snippet that is
 * running right now (Runtime.terminateExecution), then — only for a tab BOB
 * opened — navigate it back to about:blank. The navigation destroys the page
 * context, which is the only reliable way to kill loops, timers and listeners
 * an earlier snippet left behind. Best effort: failures are ignored because
 * the tab may already be gone.
 */
function recycle(call: PageCall): Promise<void> {
  if (!call.cleaning) {
    call.cleaning = (async () => {
      if (call.evaluating) {
        await settleWithin(
          call.client.send("Runtime.terminateExecution", {}, call.sessionId).catch(() => undefined),
        );
      }
      if (call.ownsTab) {
        await settleWithin(
          call.client
            .send("Page.navigate", { url: "about:blank" }, call.sessionId)
            .catch(() => undefined),
        );
      }
    })();
  }
  return call.cleaning;
}

const verbsCache = new Map<string, Promise<VerbsModule>>();

/** The shared verbs, evaluated from the workspace copy (cached per root). */
function loadVerbs(platform: Platform): Promise<VerbsModule> {
  const key = platform.workspaceRoot;
  let pending = verbsCache.get(key);
  if (!pending) {
    pending = (async () => {
      const mod = await createModuleLoader(platform).load("app/browser/src/verbs.js");
      if (typeof mod.makeTools !== "function") {
        throw new Error("app/browser/src/verbs.js does not export makeTools");
      }
      return mod as unknown as VerbsModule;
    })();
    // A missing/stale app copy must not poison every later call.
    pending.catch(() => verbsCache.delete(key));
    verbsCache.set(key, pending);
  }
  return pending;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Stand-ins that say why the shared verbs could not be loaded. */
function unavailableTools(reason: string): Record<string, KatTool> {
  const names = ["browser_exec", "browser_clickables", "browser_body", "browser_click"];
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        description: `${name} is unavailable: ${reason}`,
        parameters: { type: "object" as const, properties: {} },
        execute: async () => ({ ok: false, error: `browser tools unavailable: ${reason}` }),
      },
    ]),
  );
}

export async function browserCdpTools(
  platform: Platform,
  { cdp, signal }: { cdp?: string; signal?: AbortSignal } = {},
): Promise<Record<string, KatTool>> {
  const endpoint = String(cdp ?? "").trim();

  // One dedicated tab per run. Every verb opens a fresh socket, but they all
  // attach to this targetId, so a failed navigation (or the user switching
  // tabs) can never make the next verb read someone else's page. Created
  // lazily; if creation fails, fall back to the newest-tab behavior.
  let workTab: Promise<string | null> | null = null;

  const createWorkTab = (client: BrowserCdp): Promise<string | null> =>
    client
      .createPageTarget("about:blank")
      .then((target) => target.targetId)
      .catch(() => null);

  /** Page calls in flight; a stop also reaches tabs left behind by earlier ones. */
  const activeCalls = new Set<PageCall>();

  /**
   * Stop cleanup when no browser verb is running: reconnect, find the pinned
   * work tab, and blank it. Loops installed by an earlier snippet in the same
   * turn are still alive even while the model is thinking, so the stop must
   * reach the tab, not just the calls.
   */
  const recyclePinnedTab = async (): Promise<void> => {
    try {
      const targetId = await workTab;
      if (!targetId) return; // no tab of ours: never touch the user's newest tab
      const client = await BrowserCdp.connect(endpoint);
      try {
        const { sessionId } = await client.pageSession(targetId);
        await settleWithin(
          client
            .send("Page.navigate", { url: "about:blank" }, sessionId)
            .catch(() => undefined),
        );
      } finally {
        await client.close();
      }
    } catch {
      // The tab is gone (or Chrome is unreachable): nothing left to clean.
    }
  };

  let stopCleanup = false;
  const onStop = (): void => {
    if (stopCleanup) return;
    stopCleanup = true;
    if (activeCalls.size) {
      for (const call of activeCalls) void recycle(call);
    } else {
      void recyclePinnedTab();
    }
  };
  if (signal) {
    if (signal.aborted) onStop();
    else signal.addEventListener("abort", onStop, { once: true });
  }

  const pageForRun = async (
    client: BrowserCdp,
  ): Promise<{ target: CdpTarget; sessionId: string; ownsTab: boolean }> => {
    if (!workTab) workTab = createWorkTab(client);
    const targetId = await workTab;
    if (targetId) {
      try {
        return { ...(await client.pageSession(targetId)), ownsTab: true };
      } catch {
        // Closed between verbs: replace it below, never read the newest tab.
        workTab = null;
      }
    }
    if (!workTab) {
      // The pinned tab is gone (or its first attach failed): one fresh work tab.
      const fresh = await createWorkTab(client);
      if (fresh) {
        workTab = Promise.resolve(fresh);
        try {
          return { ...(await client.pageSession(fresh)), ownsTab: true };
        } catch {
          workTab = null;
        }
      }
    }
    // Tab creation itself failed: today's behavior is the only option left.
    return { ...(await client.pageSession()), ownsTab: false };
  };

  const session: Session = {
    profileHint: isLoopbackPage()
      ? "Uses the local Chrome started by `npm run chrome`, in this run's dedicated " +
        "work tab (a tab is opened when none exists)."
      : "Uses the Chrome window opened by Sync… → Connect browser…, in this run's " +
        "dedicated work tab (a tab is opened when none exists).",
    async withPage(fn) {
      if (!endpoint) throw new Error(NOT_CONNECTED);
      const client = await BrowserCdp.connect(endpoint);
      let call: PageCall | null = null;
      const onPageStop = (): void => {
        if (call) void recycle(call);
      };
      signal?.addEventListener("abort", onPageStop, { once: true });
      try {
        throwIfStopped(signal);
        const { target, sessionId, ownsTab } = await pageForRun(client);
        call = { client, sessionId, ownsTab, evaluating: false, cleaning: null };
        activeCalls.add(call);
        if (signal?.aborted) {
          // The stop landed while the tab was being opened: clean it up before
          // the first snippet can be injected.
          await recycle(call);
          throw new AgentStoppedError();
        }
        /** Track evaluation so a stop terminates only a running snippet. */
        const track = <T>(run: () => Promise<T>): Promise<T> => {
          call!.evaluating = true;
          return run().finally(() => {
            call!.evaluating = false;
          });
        };
        return await fn({
          url: target.url ?? null,
          launched: false,
          evaluate: (code) => track(() => client.evaluate(code, sessionId, { signal })),
          evaluateHandles: (expression) =>
            track(() => client.evaluateHandles(expression, sessionId, undefined, signal)),
          callFunction: (objectId, functionDeclaration) =>
            client.callFunction(objectId, functionDeclaration, sessionId, signal),
          eventListenerTypes: (objectId) =>
            client.eventListenerTypes(objectId, sessionId, undefined, signal),
        });
      } finally {
        signal?.removeEventListener("abort", onPageStop);
        if (call) activeCalls.delete(call);
        // A stop recycles the tab; let the cleanup finish before the socket
        // holding its session closes, or target/page calls fail half-done.
        if (call?.cleaning) await call.cleaning;
        await client.close();
      }
    },
  };

  let verbs: VerbsModule;
  try {
    verbs = await loadVerbs(platform);
  } catch (err) {
    return unavailableTools(errorText(err));
  }

  return Object.fromEntries(verbs.makeTools(session).map((tool) => [tool.name, tool]));
}
