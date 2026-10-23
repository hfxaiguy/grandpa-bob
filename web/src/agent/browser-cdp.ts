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
import { BrowserCdp } from "./cdp";
import { createModuleLoader } from "./module-loader";
import type { KatTool } from "./browser-tools";
import type { Platform } from "../../../src/platform/types";

const NOT_CONNECTED =
  "browser tools are not connected. Run `npm run chrome` in the grandpa-bob repo and open " +
  "bob from the URL it prints (it adds ?cdp=…). If Chrome was already running on the debug " +
  "port, quit it and run `npm run chrome` again so it starts with --remote-allow-origins.";

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
  { cdp }: { cdp?: string } = {},
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

  const pageForRun = async (client: BrowserCdp) => {
    if (!workTab) workTab = createWorkTab(client);
    const targetId = await workTab;
    if (targetId) {
      try {
        return await client.pageSession(targetId);
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
          return await client.pageSession(fresh);
        } catch {
          workTab = null;
        }
      }
    }
    // Tab creation itself failed: today's behavior is the only option left.
    return client.pageSession();
  };

  const session: Session = {
    profileHint:
      "Uses the local Chrome started by `npm run chrome`, in this run's dedicated " +
      "work tab (a tab is opened when none exists).",
    async withPage(fn) {
      if (!endpoint) throw new Error(NOT_CONNECTED);
      const client = await BrowserCdp.connect(endpoint);
      try {
        const { target, sessionId } = await pageForRun(client);
        return await fn({
          url: target.url ?? null,
          launched: false,
          evaluate: (code) => client.evaluate(code, sessionId),
          evaluateHandles: (expression) => client.evaluateHandles(expression, sessionId),
          callFunction: (objectId, functionDeclaration) =>
            client.callFunction(objectId, functionDeclaration, sessionId),
          eventListenerTypes: (objectId) => client.eventListenerTypes(objectId, sessionId),
        });
      } finally {
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
