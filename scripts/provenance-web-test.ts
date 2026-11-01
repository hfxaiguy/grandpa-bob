/**
 * Browser provenance: "what was this reply written from?"
 *
 * The standalone host answers ⓘ from the run log in `web/src/provenance.ts` —
 * a read-only walk from a bubble's emit row to the prompt that produced it,
 * the slots that prompt read, their writers (depth-walked) and ref:// handles.
 * The Node admin's implementation was deleted with the admin host, so this
 * pins the browser walk against a REAL engine run, written through the same
 * logger the tab uses:
 *
 *   1. a tree with two memory slots (line reads who) and a prompt (reply reads
 *      line) produces authentic `reads` links on the logged rows;
 *   2. the turn marker anchors the bubble by text; the prompt is found through
 *      the record row carrying its output (match "text");
 *   3. depth 2 walks line → who, and the slot with no reads is a leaf;
 *   4. an emit no prompt produced falls back to the nearest call ("nearest");
 *   5. a turn with no run logs returns null; the endpoint answers 200/404 and
 *      parses bubble/depth/text/q.
 *
 * Node platform, no network, no browser. Run: npm run test:provenance
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Tree, name, Memory, Prompt, Emit, Return, knit } from "grandma-kat";
import { createNodePlatform } from "../src/platform/node.ts";
import { createWorkspaceLogger } from "../web/src/agent/logger.ts";
import { writeTurnEnd } from "../web/src/agent/log-store.ts";
import { pickEmitAnchor, provenanceFor } from "../web/src/provenance.ts";
import { createLocalBackend } from "../web/src/server/local-backend.ts";
import type { AgentClient } from "../web/src/agent/agent-client.ts";
import type { Platform } from "../web/src/platform/types.ts";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-provenance-"));
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
const platform: Platform = createNodePlatform(ws);

const chat = "web:provenance-test";
const models = {
  default: { model: "mock", handler: async () => ({ content: "hello Ada" }) },
};

// `line` reads `who`; `reply` reads `line`. The reads links are the engine's
// own provenance metadata, so the walk is exercised on real rows.
const tree = () =>
  Tree(
    name("provenance"),
    Memory("who", () => "Ada"),
    Memory("line", (m: Record<string, unknown>) => `hi ${String(m.who)}`),
    Prompt("reply", (m: Record<string, unknown>) => String(m.line)),
    Emit((m: Record<string, unknown>) => ({ text: m.reply })),
    Emit(() => "a note with no prompt"),
    Return((m: Record<string, unknown>) => m.reply),
  );

const logger = createWorkspaceLogger(platform);
await logger.ready;
const result = await knit(tree(), { models, logger, sessionId: chat });
assert.ok(typeof result === "object" && result && "result" in result, "the tree completed");
await logger.flush();

const runId = result.runId;
assert.ok(runId, "the run has an id");

const TURN = "turn-provenance";
await writeTurnEnd(platform, {
  key: chat,
  turnId: TURN,
  runId: runId!,
  input: "draw the graph",
  status: "done",
  output: "hello Ada",
  startedAt: Date.now() - 1000,
  endedAt: Date.now(),
  ts: Date.now(),
});

// ── 1. the anchored bubble: prompt, pieces, depth walk ───────────────────
const prov = await provenanceFor(platform, { turnId: TURN, bubble: 0, text: "hello Ada" });
assert.ok(prov, "the turn's emit resolves");
assert.equal(prov!.emit.text, "hello Ada", "the emit text is the bubble's");
assert.equal(prov!.match, "text", "the prompt is found through the record carrying its output");
assert.equal(prov!.prompt?.child, "reply", "the prompt is the emitting tree's Prompt()");
assert.ok((prov!.prompt?.messages.length ?? 0) >= 1, "the prompt's messages are logged");
assert.ok(
  prov!.prompt!.messages.some((m) => m.content.includes("hi Ada")),
  "the prompt messages carry the memory value it read",
);
assert.equal(prov!.prompt?.round, 1, "the round is logged");
assert.ok(prov!.depth === 1 && prov!.maxDepth === 6, "depth caps are reported");

const linePiece = prov!.pieces.find((p) => p.name === "line");
assert.ok(linePiece, "the prompt's read of `line` is a piece");
assert.equal(linePiece!.resolved, "read-link", "the read carries its writer's seq");
assert.equal(linePiece!.writer?.kind, "record", "the writer is the memory write row");
assert.equal(linePiece!.writer?.op, "memory", "the write is a Memory() capture");
assert.equal(linePiece!.writer?.text, "hi Ada", "the writer's value is shown");
assert.equal(linePiece!.reads, undefined, "depth 1 does not walk the writer's reads");

const deeper = await provenanceFor(platform, { turnId: TURN, bubble: 0, text: "hello Ada", depth: 2 });
const deeperLine = deeper!.pieces.find((p) => p.name === "line");
assert.ok(deeperLine?.reads?.length, "depth 2 walks the writer's own reads");
const whoPiece = deeperLine!.reads!.find((p) => p.name === "who");
assert.ok(whoPiece, "line's read of `who` is reached");
assert.equal(whoPiece!.writer?.text, "Ada", "the seed value is the ground fact");
assert.equal(whoPiece!.resolved, "read-link", "the nested read is linked too");
assert.ok(
  deeper!.leaves.some((l) => l.text === "Ada"),
  `the slot with no reads is a leaf, got ${JSON.stringify(deeper!.leaves.map((l) => l.text))}`,
);

// ── 2. an emit no prompt produced falls back to the nearest call ─────────
const noteAnchor = pickEmitAnchor(
  [
    { seq: prov!.emit.seq, text: "hello Ada" },
    { seq: prov!.emit.seq + 1, text: "a note with no prompt" },
  ],
  1,
  "a note with no prompt",
);
assert.equal(noteAnchor, 1, "pickEmitAnchor prefers the bubble's own text");
const note = await provenanceFor(platform, { turnId: TURN, bubble: 1, text: "a note with no prompt" });
assert.ok(note, "the note bubble resolves");
assert.equal(note!.match, "nearest", "no text match is flagged as nearest");
assert.equal(note!.prompt?.child, "reply", "the nearest call is still shown");

// ── 3. a turn with no engine run has nothing to trace ────────────────────
assert.equal(await provenanceFor(platform, { turnId: "turn-missing" }), null);

// A bubble index out of range still anchors by text (the UI may pass -1).
const byText = await provenanceFor(platform, { turnId: TURN, bubble: 99, text: "hello Ada" });
assert.equal(byText!.bubble, prov!.bubble, "the text wins over a stale bubble index");

// A LIVE turn (no marker yet): the page's own rows are merged so ⓘ works
// mid-turn, before the logger's next flush.
const liveLogger = createWorkspaceLogger(platform);
await liveLogger.ready;
const liveRun = await knit(tree(), { models, logger: liveLogger, sessionId: "web:live-provenance" });
const liveRows = liveLogger.events
  .filter((e) => typeof e.seq === "number" && typeof e.run_id === "string" && typeof e.kind === "string")
  .map((e) => ({
    seq: e.seq as number,
    run_id: e.run_id as string,
    branch_path: e.branch_path ?? null,
    iteration: typeof e.iteration === "number" ? e.iteration : null,
    scope_id: typeof e.scope_id === "number" ? e.scope_id : null,
    kind: e.kind,
    content: e.content ?? null,
  }));
const liveProv = await provenanceFor(platform, {
  turnId: "turn-live",
  bubble: 0,
  text: "hello Ada",
  live: { runId: liveRun.runId, rows: liveRows },
});
assert.ok(liveProv, "a live turn's unflushed rows are traceable");
assert.equal(liveProv!.match, "text", "the live walk finds the prompt too");
assert.equal(liveProv!.prompt?.child, "reply", "the live prompt is the same tree's");
await liveLogger.close();

// ── 4. the endpoint parses the query and answers 200/404 ─────────────────
const stubAgent = {
  log: async (op: string, payload: Record<string, unknown>) =>
    op === "provenance" ? provenanceFor(platform, payload as never) : null,
} as unknown as AgentClient;
const backend = createLocalBackend({
  agent: stubAgent,
  platform,
  env: {},
  remote: "",
  initialPattern: "trunk",
});
const ok = await backend.request(
  "GET",
  "/api/provenance",
  new URLSearchParams({ turnId: TURN, bubble: "0", text: "hello Ada", depth: "2" }),
  null,
);
assert.equal(ok.status, 200, "the endpoint serves the walk");
const body = ok.body as Record<string, unknown>;
assert.equal(body.match, "text", "the endpoint returns the walk payload");
assert.equal(body.turnId, TURN, "the turn id is echoed");
assert.equal(body.bubble, 0, "the resolved anchor index is echoed");
assert.ok(Number(body.emitCount) >= 2, "the emit count is echoed");

const missing = await backend.request("GET", "/api/provenance", new URLSearchParams({ turnId: "nope" }), null);
assert.equal(missing.status, 404, "a turn with no run is a friendly 404");
const noTurn = await backend.request("GET", "/api/provenance", new URLSearchParams(), null);
assert.equal(noTurn.status, 400, "turnId is required");

console.log("provenance: ok — prompt, read-graph depth, nearest fallback, endpoint 200/404");
await fs.rm(ws, { recursive: true, force: true });
