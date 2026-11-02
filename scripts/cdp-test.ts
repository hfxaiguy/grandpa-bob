/**
 * Browser-side CDP client (web/src/agent/cdp.ts).
 *
 * The worker cannot use /json/* (CORS) and needs flat sessions, so the client
 * drives everything over the browser-level socket. These tests use a fake
 * WebSocket to pin the wire shapes: newest-page selection, attach reuse,
 * sessionId on every request, console-style evaluate (raw -> async wrapper on
 * SyntaxError), navigation-race retry, object handles and DOMDebugger.
 *
 * Live check against a real Chrome (start one with `npm run chrome`):
 *   CDP_LIVE=ws://127.0.0.1:9222/devtools/browser/<id> npm run test:cdp
 *
 * Run: `npm run test:cdp`.
 */
import assert from "node:assert/strict";
import { BrowserCdp, type WebSocketCtor } from "../web/src/agent/cdp.ts";

type Listener = (ev: unknown) => void;
type Response = { result?: unknown; error?: { message: string } };
interface SentMessage {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

class FakeSocket {
  static last: FakeSocket | null = null;
  static failNext = false;
  /** Fail every handshake (BrowserCdp retries, so `failNext` alone recovers). */
  static failAll = false;
  url: string;
  readyState = 0;
  sent: SentMessage[] = [];
  /** Return `null` to leave a call pending (the stop tests need a live script). */
  handler: ((msg: SentMessage) => Response | null) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
    queueMicrotask(() => {
      if (FakeSocket.failAll || FakeSocket.failNext) {
        FakeSocket.failNext = false;
        this.emit("error", {});
        return;
      }
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as SentMessage;
    this.sent.push(msg);
    if (this.handler) {
      const response = this.handler(msg);
      if (response === null) return; // deliberate: wait for the test to settle it
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: msg.id, ...response }) }));
      return;
    }
    queueMicrotask(() =>
      this.emit("message", {
        data: JSON.stringify({ id: msg.id, error: { message: `no handler for ${msg.method}` } }),
      }),
    );
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

const connect = (): Promise<BrowserCdp> =>
  BrowserCdp.connect("ws://test/devtools/browser/x", {
    WebSocketImpl: FakeSocket as unknown as WebSocketCtor,
  });

// ── targets, attach reuse, sessionId on requests ────────────────────────
{
  const client = await connect();
  const ws = FakeSocket.last!;
  ws.handler = (msg) => {
    if (msg.method === "Target.getTargets") {
      return {
        result: {
          targetInfos: [
            { targetId: "p1", type: "page", url: "https://old.example", title: "Old" },
            { targetId: "p2", type: "page", url: "https://new.example", title: "New" },
            { targetId: "w1", type: "service_worker", url: "https://new.example/sw.js", title: "" },
          ],
        },
      };
    }
    if (msg.method === "Target.attachToTarget") return { result: { sessionId: "s1" } };
    if (msg.method === "Runtime.evaluate") return { result: { result: { type: "number", value: 42 } } };
    return { error: { message: `unexpected ${msg.method}` } };
  };

  const first = await client.pageSession();
  assert.equal(first.target.targetId, "p2", "the newest page target wins");
  assert.equal(first.sessionId, "s1");

  const second = await client.pageSession();
  assert.equal(second.sessionId, "s1");
  assert.equal(
    ws.sent.filter((m) => m.method === "Target.attachToTarget").length,
    1,
    "a target is attached once",
  );

  assert.equal(await client.evaluate("6*7", second.sessionId), 42);
  const evalMsg = ws.sent.find((m) => m.method === "Runtime.evaluate")!;
  assert.equal(evalMsg.sessionId, "s1", "flat session id is sent with the call");
  assert.equal(evalMsg.params.returnByValue, true);
  assert.equal(evalMsg.params.awaitPromise, true);
  await client.close();
}

// ── console-style evaluate: SyntaxError falls back to the async wrapper ──
{
  const client = await connect();
  const ws = FakeSocket.last!;
  let evals = 0;
  ws.handler = (msg) => {
    if (msg.method !== "Runtime.evaluate") return { error: { message: `unexpected ${msg.method}` } };
    evals += 1;
    if (evals === 1) {
      return {
        result: {
          exceptionDetails: {
            text: "SyntaxError: Illegal return statement",
            exception: { className: "SyntaxError" },
          },
        },
      };
    }
    return { result: { result: { type: "number", value: 7 } } };
  };
  assert.equal(await client.evaluate("return 7", "s1"), 7);
  const sent = ws.sent.filter((m) => m.method === "Runtime.evaluate");
  assert.match(sent[1].params.expression as string, /^\(async \(\) =>/, "top-level return uses a wrapper");
  await client.close();
}

// ── navigation race: retried once, then succeeds ────────────────────────
{
  const client = await connect();
  const ws = FakeSocket.last!;
  let evals = 0;
  ws.handler = (msg) => {
    if (msg.method !== "Runtime.evaluate") return { error: { message: `unexpected ${msg.method}` } };
    evals += 1;
    if (evals === 1) return { error: { message: "Execution context was destroyed." } };
    return { result: { result: { type: "string", value: "ok" } } };
  };
  assert.equal(await client.evaluate("location.href", "s1"), "ok");
  assert.equal(evals, 2);
  await client.close();
}

// ── stop: a pending evaluate is abandoned, never re-injected ────────────
{
  const client = await connect();
  const ws = FakeSocket.last!;
  ws.handler = (msg) =>
    msg.method === "Runtime.evaluate" ? null : { error: { message: `unexpected ${msg.method}` } };

  const ctrl = new AbortController();
  let rejected: unknown;
  const pending = client.evaluate("await new Promise(() => {})", "s1", { signal: ctrl.signal });
  pending.catch((err) => {
    rejected = err;
  });
  await new Promise((resolve) => setTimeout(resolve, 10)); // the snippet is on the wire
  assert.equal(ws.sent.filter((m) => m.method === "Runtime.evaluate").length, 1);

  ctrl.abort();
  await assert.rejects(pending, /stopped by user/);
  assert.equal((rejected as Error)?.name, "AbortError", "the stop stays abort-shaped");
  assert.equal(
    ws.sent.filter((m) => m.method === "Runtime.evaluate").length,
    1,
    "a stop never re-sends the snippet",
  );
  await client.close();
}

// ── stop before an evaluate: nothing reaches Chrome ─────────────────────
{
  const client = await connect();
  const ws = FakeSocket.last!;
  ws.handler = () => ({ result: { result: { type: "number", value: 1 } } });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    client.evaluate("1 + 1", "s1", { signal: ctrl.signal }),
    /stopped by user/,
    "a stopped turn injects no code",
  );
  assert.equal(ws.sent.length, 0);
  await client.close();
}

// ── stop during the navigation-race retry: no second evaluate ───────────
{
  const client = await connect();
  const ws = FakeSocket.last!;
  let evals = 0;
  ws.handler = (msg) => {
    if (msg.method !== "Runtime.evaluate") return { error: { message: `unexpected ${msg.method}` } };
    evals += 1;
    return { error: { message: "Execution context was destroyed." } };
  };
  const ctrl = new AbortController();
  const pending = client.evaluate("location.href", "s1", { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 50); // lands during the 400ms retry delay
  await assert.rejects(pending, /stopped by user/);
  assert.equal(evals, 1, "the retry loop checks the stop signal");
  await client.close();
}

// ── object handles, DOMDebugger listeners, callFunctionOn ───────────────
{
  const client = await connect();
  const ws = FakeSocket.last!;
  ws.handler = (msg) => {
    if (msg.method === "Runtime.evaluate") return { result: { result: { objectId: "arr" } } };
    if (msg.method === "Runtime.getProperties") {
      return {
        result: {
          result: [
            { name: "1", value: { objectId: "b" } },
            { name: "0", value: { objectId: "a" } },
            { name: "length", value: { value: 2 } },
          ],
        },
      };
    }
    if (msg.method === "DOMDebugger.getEventListeners") {
      return { result: { listeners: [{ type: "click" }, { type: "keydown" }] } };
    }
    if (msg.method === "Runtime.callFunctionOn") return { result: { result: { value: 3 } } };
    return { error: { message: `unexpected ${msg.method}` } };
  };

  assert.deepEqual(await client.evaluateHandles("[...document.body.children]", "s1"), ["a", "b"]);
  assert.deepEqual(await client.eventListenerTypes("a", "s1"), ["click", "keydown"]);
  assert.equal(await client.callFunction("a", "function () { return 3; }", "s1"), 3);
  const withSession = ws.sent.filter((m) => m.sessionId === "s1");
  assert.ok(withSession.length >= 4, "handles/listeners/calls carry the session id");
  await client.close();
}

// ── connection failure carries the fix ──────────────────────────────────
{
  FakeSocket.failAll = true;
  try {
    await assert.rejects(connect, /npm run chrome/, "a failed upgrade points at the launcher");
  } finally {
    FakeSocket.failAll = false;
  }
}

// ── optional live check against a real Chrome ──────────────────────────
const live = process.env.CDP_LIVE;
if (live) {
  const client = await BrowserCdp.connect(live);
  try {
    const { sessionId } = await client.pageSession();
    assert.equal(await client.evaluate("2 + 2", sessionId), 4);
    assert.equal(await client.evaluate("return 2 + 3", sessionId), 5);
    console.log("cdp: live Chrome evaluate OK");
  } finally {
    await client.close();
  }
}

console.log("cdp: targets, flat sessions, evaluate, handles and listener probes OK");
