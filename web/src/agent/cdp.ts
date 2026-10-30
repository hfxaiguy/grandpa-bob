/**
 * CDP client that runs inside the agent worker.
 *
 * The Node target drives Chrome through /json/list + page sockets. A worker
 * cannot: /json/* is CORS-gated and Chrome 111+ rejects WebSocket upgrades
 * whose Origin it does not allow. So this client connects to the
 * BROWSER-level socket (`/devtools/browser/<id>`), which the launcher script
 * (`npm run chrome`) hands to the page as `?cdp=…`, and does everything over
 * flat sessions:
 *
 *   Target.getTargets      instead of GET /json/list
 *   Target.createTarget    instead of PUT /json/new
 *   Target.attachToTarget  { flatten: true } -> a sessionId
 *   Runtime.evaluate / Runtime.callFunctionOn / DOMDebugger.getEventListeners
 *                          with that sessionId
 *
 * The evaluate/unwrap/retry semantics mirror the workspace app's cdp.js on
 * purpose: the snippets in app/browser/src/*.js are shared between targets.
 */

export type WebSocketCtor = new (url: string) => WebSocket;

export interface CdpConnectOptions {
  /** Injectable for tests; defaults to the worker's global WebSocket. */
  WebSocketImpl?: WebSocketCtor;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Open-handshake timeout (per attempt). */
  openTimeoutMs?: number;
  /** Handshake attempts before giving up. Defaults to 3. */
  connectAttempts?: number;
  /** Delay between handshake attempts. Defaults to 1s. */
  retryDelayMs?: number;
}

export interface CdpTarget {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** True on a loopback page — the self-hosted `npm run chrome` flow. */
export function isLoopbackPage(): boolean {
  try {
    const host = globalThis.location?.hostname ?? "";
    return (
      !host || host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
    );
  } catch {
    return true;
  }
}

const LOCAL_CDP_HELP =
  "cannot reach the local Chrome. Start it with `npm run chrome` in the grandpa-bob " +
  "repo and open bob from the URL it prints (it carries ?cdp=…); if Chrome was " +
  "already running on the debug port, quit it and run `npm run chrome` again so it " +
  "starts with --remote-allow-origins.";

const HOSTED_CDP_HELP =
  "browser tools are not connected. In the toolbar open Sync… → Connect browser… and " +
  "run the command it copies for your system, then reload this page. It starts a " +
  "separate Chrome with the automation port BOB needs.";

export const CDP_UNAVAILABLE = isLoopbackPage() ? LOCAL_CDP_HELP : HOSTED_CDP_HELP;

/** Turn a Runtime.evaluate result into a value or an Error. */
function unwrap(result: unknown): unknown {
  const r = result as {
    exceptionDetails?: { exception?: { description?: string; className?: string }; text?: string };
    result?: { type?: string; value?: unknown; description?: string };
  };
  const details = r?.exceptionDetails;
  if (details) {
    const description = details.exception?.description || details.text || "evaluation failed";
    const error = new Error(description);
    // Keep the page's error class so a SyntaxError can be told apart.
    error.name = details.exception?.className || "EvalError";
    throw error;
  }
  const { type, value, description } = r?.result ?? {};
  // DOM nodes, functions, promises-that-never-resolved: returnByValue drops
  // the value, so hand back the description text instead.
  if (type !== "undefined" && value === undefined && description != null) return description;
  return value ?? null;
}

/** The async wrapper used when the raw script form does not parse. */
export const asyncWrap = (code: string): string => `(async () => {\n${code}\n})()`;

/** A navigation raced the evaluation and killed its context — retry. */
const RACE =
  /context was destroyed|cannot find context|inspected target navigated|target closed|CDP timeout|session with given id not found|no target with given id/i;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BrowserCdp {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed: Error | null = null;
  private sessions = new Map<string, string>();
  private timeoutMs: number;

  private constructor(
    private ws: WebSocket,
    opts: CdpConnectOptions,
  ) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    ws.addEventListener("message", (event: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return; // events are not used
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP error"));
      else entry.resolve(msg.result);
    });
    const fail = (): void => {
      const err = new Error("CDP socket closed");
      this.closed = err;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    };
    ws.addEventListener("close", fail);
    ws.addEventListener("error", fail);
  }

  static async connect(url: string, opts: CdpConnectOptions = {}): Promise<BrowserCdp> {
    const attempts = Math.max(1, opts.connectAttempts ?? 3);
    const retryDelayMs = opts.retryDelayMs ?? 1_000;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await BrowserCdp.connectOnce(url, opts);
      } catch (err) {
        lastError = err;
        // A bad URL/implementation will never heal; do not storm it.
        if ((err as { permanent?: boolean })?.permanent) throw err;
        if (attempt < attempts - 1) await sleep(retryDelayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private static connectOnce(url: string, opts: CdpConnectOptions): Promise<BrowserCdp> {
    const Impl = opts.WebSocketImpl ?? (globalThis.WebSocket as WebSocketCtor);
    if (!Impl) return Promise.reject(new Error("WebSocket is not available in this environment"));
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new Impl(url);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        (error as Error & { permanent?: boolean }).permanent = true;
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error(`timed out connecting to ${url}. ${CDP_UNAVAILABLE}`));
      }, opts.openTimeoutMs ?? 5_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new BrowserCdp(ws, opts));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // already closed
        }
        reject(new Error(`cannot connect to ${url}. ${CDP_UNAVAILABLE}`));
      });
    });
  }

  /** One JSON-RPC request; `sessionId` targets an attached page (flat mode). */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout"));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(): Promise<void> {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    this.closed = this.closed ?? new Error("CDP socket closed");
  }

  /** Page targets, oldest first (the last one is Chrome's newest tab). */
  async pageTargets(): Promise<CdpTarget[]> {
    const { targetInfos = [] } = await this.send<{ targetInfos?: CdpTarget[] }>("Target.getTargets");
    return targetInfos.filter(
      (t) => t.type === "page" && !String(t.url ?? "").startsWith("devtools://"),
    );
  }

  /** The newest page target, or a fresh about:blank tab when none exists. */
  async pageTarget(): Promise<CdpTarget> {
    const pages = await this.pageTargets();
    const newest = pages[pages.length - 1];
    if (newest) return newest;
    return this.createPageTarget();
  }

  /** Open a dedicated about:blank work tab and return its target. */
  async createPageTarget(url = "about:blank"): Promise<CdpTarget> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url });
    return { targetId, type: "page", url, title: "" };
  }

  /** A page target by id, or null when it has been closed. */
  async targetById(targetId: string): Promise<CdpTarget | null> {
    const pages = await this.pageTargets();
    return pages.find((target) => target.targetId === targetId) ?? null;
  }

  /** Attach (once) to a page target; returns the flat session id. */
  async attach(targetId: string): Promise<string> {
    const known = this.sessions.get(targetId);
    if (known) return known;
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.sessions.set(targetId, sessionId);
    return sessionId;
  }

  /**
   * The page session tools work against. With `targetId`, that exact tab
   * (the run's pinned work tab); otherwise Chrome's newest tab, or a fresh
   * about:blank tab when none exists.
   */
  async pageSession(targetId?: string): Promise<{ target: CdpTarget; sessionId: string }> {
    if (targetId) {
      const target = await this.targetById(targetId);
      if (!target) throw new Error(`work tab ${targetId} is gone`);
      return { target, sessionId: await this.attach(target.targetId) };
    }
    const target = await this.pageTarget();
    const sessionId = await this.attach(target.targetId);
    return { target, sessionId };
  }

  /**
   * Evaluate a snippet like the DevTools console:
   *   - a bare expression returns its completion value (`document.title`)
   *   - statement lists return the last value (`const a = 1; a + 1`)
   *   - `return` and top-level `await` work through an async wrapper, tried
   *     only when the raw form fails to parse.
   * A page that navigates mid-snippet destroys its execution context; retry,
   * since the snippet never completed in the old context.
   */
  async evaluate(
    code: string,
    sessionId: string,
    { timeoutMs = this.timeoutMs, retries = 2 }: { timeoutMs?: number; retries?: number } = {},
  ): Promise<unknown> {
    const source = String(code ?? "");
    const raw = (expression: string): Promise<unknown> =>
      this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, sessionId);
    for (let attempt = 0; ; attempt++) {
      try {
        try {
          return unwrap(await raw(source));
        } catch (err) {
          if ((err as Error).name !== "SyntaxError") throw err;
          return unwrap(await raw(asyncWrap(source)));
        }
      } catch (err) {
        if (attempt >= retries || !RACE.test(String((err as Error)?.message ?? ""))) throw err;
        await sleep(400);
      }
    }
  }

  /**
   * Evaluate an expression whose value is an array and keep an object handle
   * for each item (returnByValue:false) — the bridge to CDP calls that need a
   * real objectId (DOMDebugger.getEventListeners above all).
   */
  async evaluateHandles(expression: string, sessionId: string, timeoutMs = this.timeoutMs): Promise<string[]> {
    const result = await this.send<{
      exceptionDetails?: { exception?: { description?: string; className?: string }; text?: string };
      result?: { objectId?: string };
    }>("Runtime.evaluate", { expression: String(expression ?? ""), awaitPromise: true, returnByValue: false, timeout: timeoutMs }, sessionId);
    const details = result?.exceptionDetails;
    if (details) {
      const error = new Error(details.exception?.description || details.text || "evaluation failed");
      error.name = details.exception?.className || "EvalError";
      throw error;
    }
    const objectId = result?.result?.objectId;
    if (!objectId) return [];
    const { result: props = [] } = await this.send<{
      result?: Array<{ name?: string; value?: { objectId?: string } }>;
    }>("Runtime.getProperties", { objectId, ownProperties: true }, sessionId);
    return props
      .filter((prop) => /^\d+$/.test(prop.name ?? "") && prop.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map((prop) => prop.value!.objectId!);
  }

  /** Event types registered on the node behind `objectId` (DOMDebugger). */
  async eventListenerTypes(objectId: string, sessionId: string, timeoutMs = this.timeoutMs): Promise<string[]> {
    const { listeners = [] } = await this.send<{ listeners?: Array<{ type?: string }> }>(
      "DOMDebugger.getEventListeners",
      { objectId },
      sessionId,
    );
    return listeners.map((listener) => listener.type ?? "");
  }

  /** Call a function on an object handle and return its value. */
  async callFunction(objectId: string, functionDeclaration: string, sessionId: string): Promise<unknown> {
    const { result } = await this.send<{ result?: { value?: unknown } }>(
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration, returnByValue: true },
      sessionId,
    );
    return result?.value;
  }
}
