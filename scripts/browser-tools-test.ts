/**
 * Worker browser tools (web/src/agent/browser-cdp.ts).
 *
 * The worker must not carry its own copy of the four verbs: browserCdpTools()
 * loads `app/browser/src/verbs.js` from the workspace through the module
 * loader and supplies only the CDP transport. These tests pin that sharing —
 * tool names/schemas/descriptions come from the app, and calls run over a
 * browser-level session — with a fake WebSocket.
 *
 * Needs a workspace containing the browser app:
 *   WORKSPACE_DIR=~/grandma-workspace npm run test:browser-tools
 *
 * Run: `npm run test:browser-tools`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserCdpTools } from "../web/src/agent/browser-cdp.ts";
import { createNodePlatform } from "../src/platform/node.js";

type Listener = (ev: unknown) => void;
interface SentMessage {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** Only what BrowserCdp uses: addEventListener("open"|"message"|"close"|"error"), send, close. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static all: SentMessage[] = [];
  static handler: ((msg: SentMessage) => unknown) | null = null;
  url: string;
  sent: SentMessage[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as SentMessage;
    this.sent.push(msg);
    FakeSocket.all.push(msg);
    const response = FakeSocket.handler?.(msg) ?? { error: { message: `no handler for ${msg.method}` } };
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: msg.id, ...response }) }));
  }

  close(): void {
    this.emit("close", {});
  }

  private emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

const workspace =
  process.env.WORKSPACE_DIR ?? path.join(os.homedir(), "grandma-workspace");
const verbsPath = path.join(workspace, "app/browser/src/verbs.js");

if (!existsSync(verbsPath)) {
  console.log(`browser-tools: skipped (no ${verbsPath})`);
} else {
  const platform = createNodePlatform(workspace);
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

  try {
    // ── the verbs come from the workspace, not from this repo ───────────
    const tools = await browserCdpTools(platform, { cdp: "ws://test/devtools/browser/x" });
    assert.deepEqual(Object.keys(tools).sort(), [
      "browser_body",
      "browser_click",
      "browser_clickables",
      "browser_exec",
    ]);
    assert.deepEqual(tools.browser_exec.parameters.required, ["code"], "schema comes from the app");
    assert.match(
      tools.browser_exec.description,
      /npm run chrome/,
      "the worker adds only its transport hint",
    );

    // ── calls run over one browser-level session per tool call ──────────
    FakeSocket.handler = (msg) => {
      if (msg.method === "Target.getTargets") {
        return { result: { targetInfos: [{ targetId: "p1", type: "page", url: "https://page.example", title: "P" }] } };
      }
      if (msg.method === "Target.attachToTarget") return { result: { sessionId: "s1" } };
      if (msg.method === "Runtime.evaluate") {
        const expression = String(msg.params.expression ?? "");
        if (expression.includes("innerText")) {
          return {
            result: {
              result: {
                type: "object",
                value: { url: "https://page.example", title: "P", text: "hello" },
              },
            },
          };
        }
        return { result: { result: { type: "number", value: 2 } } };
      }
      return { error: { message: `unexpected ${msg.method}` } };
    };

    const exec = await tools.browser_exec.execute({ code: "1 + 1" });
    assert.equal(exec.ok, true, String(exec.error ?? ""));
    assert.equal(exec.value, 2);
    assert.equal(exec.launched, false, "the worker never launches Chrome itself");

    const body = await tools.browser_body.execute({ max: 3 });
    assert.equal(body.ok, true, String(body.error ?? ""));
    assert.equal(body.text, "hello");
    assert.equal(body.url, "https://page.example");

    const evals = FakeSocket.all.filter((m) => m.method === "Runtime.evaluate");
    assert.ok(evals.length >= 2);
    assert.ok(evals.every((m) => m.sessionId === "s1"), "requests carry the flat session id");
    assert.ok(
      evals.some((m) => String(m.params.expression).includes("slice(0, 3)")),
      "the app's page snippet (max) is what runs",
    );

    // ── no endpoint: the tools explain the fix instead of connecting ────
    const offline = await browserCdpTools(platform, {});
    const refused = await offline.browser_exec.execute({ code: "1 + 1" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /npm run chrome/);

    console.log(
      "browser-tools: worker loads app/browser/src/verbs.js, runs over flat sessions, and stubs without ?cdp",
    );
  } finally {
    globalThis.WebSocket = RealWebSocket;
  }
}
