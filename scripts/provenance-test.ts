/**
 * Message provenance — "what was this reply written from?"
 *
 * Runs one real grandma-kat tree through the Agent against a temp log DB,
 * then walks the log with ProvenanceReader:
 *
 *   1. listEmits: every emitted bubble in a turn's bounds, in order (machine
 *      narration included — it is a bubble too).
 *   2. provenance(emit): the prompt that produced the text is found through
 *      the record rows carrying it; its `reads` become the pieces (memory
 *      slots, the human input), with the writer row (value, kind, seq) for
 *      each.
 *   3. depth 2 walks each writer's own reads ("trace deeper") and bottoms out
 *      in ground-fact leaves.
 *   4. ref://<name>.<seq> handles in the prompt's messages resolve to their rows.
 *   5. pickEmitAnchor prefers the bubble's text over its index, and
 *      WebLog.findTurn resolves a turnId to its marker.
 *
 * Mock model handler, no network. Run: npm run test:provenance
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import events from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "grandma-kat";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/index.js";
import { ensureRepo } from "../src/tools/git.js";
import { ProvenanceReader, pickEmitAnchor, when } from "../src/provenance.js";
import { WebLog } from "../src/web-log.js";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-provenance-"));
await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
await fs.mkdir(path.join(ws, "logs"), { recursive: true });
await ensureRepo(ws);

await fs.writeFile(
  path.join(ws, "patterns", "prov.mjs"),
  `export default function ({ Tree, name, Model, Human, Prompt, Memory, Emit, Return }) {
     return Tree(
       name("prov"),
       Model("cheap"),
       Memory("facts", () => ["alpha", "beta"]),
       Memory("derived", (m) => "d:" + String(m.facts && m.facts[0])),
       Human("input_1"),
       Prompt((m) => [
         { role: "system", content: "facts=" + JSON.stringify(m.facts) + " derived=" + String(m.derived) },
         { role: "user", content: "ask: " + String(m.branch.input_1 || "") },
       ]),
       Memory("answer", (m) => m.prev[0]),
       Emit((m) => m.answer),
       Emit(() => ({ machine: { tree: "prov", doing: "test" } })),
       Emit((m) => "guard: " + String(m.answer || "")),
       Return((m) => m.answer),
     );
   }\n`,
);

const handler = async () => ({ content: "pong-1", reasoning: null, tool_calls: [] });
const models = { cheap: { model: "cheap", handler } } as any;
const tools = new ToolRegistry(ws, ["ls"]);

const dbPath = path.join(ws, "logs", "grandma-kat.db");
const katLogger = createLogger(dbPath, "none") as { close(): void };
const agent = new Agent({
  models,
  workspace: ws,
  tools,
  patternName: () => "prov",
  logger: katLogger,
});

// Turn 1 (grow): lands at the Human before any prompt or emit.
{
  const r = await agent.run("web:prov", "", () => {}, { onEvent: () => {} });
  assert.equal(r.status, "waiting", "paused at the first Human");
}
// Turn 2: prompt + the three emits.
{
  const r = await agent.run("web:prov", "ping", () => {}, { onEvent: () => {} });
  assert.equal(r.status, "done", "the tree completed");
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const runId = (db.prepare("SELECT run_id FROM runs LIMIT 1").get() as { run_id: string }).run_id;
assert.ok(runId, "the run registered");
const maxSeq = Number((db.prepare("SELECT MAX(seq) m FROM calls").get() as { m: number }).m);

const reader = new ProvenanceReader(dbPath);

// 1. Every emit in the turn's bounds is a bubble, in order — machine too.
const emits = reader.listEmits(runId, 0, maxSeq);
assert.deepEqual(
  emits.map((e) => e.text),
  ["pong-1", "prov test", "guard: pong-1"],
  "three bubbles, in emit order (machine narration included)",
);

/** The emit row a bubble text is anchored on. */
const anchorOf = (text: string) => {
  const i = pickEmitAnchor(emits, -1, text);
  assert.ok(i >= 0, `anchor found for ${JSON.stringify(text)}`);
  return emits[i].seq;
};

/** The seq of the record row that wrote a slot (op memory/memoryUpdate). */
const slotSeq = (name: string) =>
  Number(
    (
      db
        .prepare(
          `SELECT MAX(seq) m FROM calls WHERE kind = 'record' AND json_extract(content, '$.child') = ?
             AND json_extract(content, '$.op') IN ('memory','memoryUpdate')`,
        )
        .get(name) as { m: number | null }
    ).m,
  );

// 2. The exact-text bubble: the prompt is found through the record that
//    carried the text, and its reads are the pieces.
{
  const p = reader.provenance(anchorOf("pong-1"), 1);
  assert.equal(p.match, "text", "exact text anchored the producing prompt");
  assert.ok(p.prompt, "a prompt was found");
  assert.ok(p.prompt!.child, "the prompt names its child");
  assert.equal(p.prompt!.messages.length, 2, "the prompt's messages were captured");
  assert.deepEqual(
    p.pieces.map((x) => x.name),
    ["facts", "derived", "input_1"],
    "pieces are the slots the prompt read, in read order",
  );

  const facts = p.pieces[0];
  // facts was written during the grow pass, before the pause: after a resume
  // the slot has no seq link, so the latest-write fallback resolves it.
  assert.equal(facts.resolved, "latest-write", "no seq link across a resume — the latest write resolved it");
  assert.equal(facts.writer?.seq, slotSeq("facts"), "facts points at its record row");
  assert.equal(facts.writer?.text, '["alpha","beta"]', "the write row's value is shown");
  assert.equal(facts.reads, undefined, "depth 1 does not expand the writer's own reads");

  const input = p.pieces[2];
  assert.equal(input.resolved, "human", "the input slot resolved to the human row");
  assert.equal(input.writer?.kind, "human");
  assert.equal(input.writer?.text, "ping", "your message is the writer's value");

  assert.ok(
    p.leaves.some((l) => l.seq === slotSeq("facts")),
    "the facts write bottoms out as a ground fact",
  );
  assert.equal(p.emit.seq, anchorOf("pong-1"));
  assert.ok(p.emit.when.length >= 16, "the emit carries its run time");
}

// 3. trace deeper: depth 2 walks the writer's own reads.
{
  const p = reader.provenance(anchorOf("pong-1"), 2);
  const derived = p.pieces.find((x) => x.name === "derived");
  assert.ok(derived?.reads?.length, "derived expands to what it was written from");
  assert.equal(derived.reads![0].name, "facts", "derived was written from facts");
  assert.equal(derived.reads![0].writer?.seq, slotSeq("facts"), "the sub-writer is the facts record");
}

// 4. A wrapped bubble with no exact record: the nearest prompt is shown, flagged.
{
  const p = reader.provenance(anchorOf("guard: pong-1"), 1);
  assert.equal(p.match, "nearest", "no exact text match — flagged as nearest");
  assert.ok(p.prompt, "the nearest prompt is still shown");
  assert.equal(p.prompt!.child, reader.provenance(anchorOf("pong-1"), 1).prompt!.child, "same prompt");
}

// 5. ref://<name>.<seq> handles in the prompt's messages resolve to their rows:
//    a synthetic prompt (rows written by hand, as a host tool would) that
//    points at real tool_result rows — one bare, one named.
{
  const wdb = new DatabaseSync(dbPath); // writable handle for the synthetic rows
  const insert = wdb.prepare(
    "INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, 'test', NULL, 1, 0, ?, ?)",
  );
  const namedSeq = Number(
    insert.run(runId, "tool_result", JSON.stringify({ tool: "sql_query", args: {}, result: "NAMED REF", isError: false }))
      .lastInsertRowid,
  );
  const toolSeq = Number(
    insert.run(runId, "tool_result", JSON.stringify({ tool: "read_file", args: {}, result: "REF CONTENT", isError: false }))
      .lastInsertRowid,
  );
  insert.run(
    runId,
    "llm_call",
    JSON.stringify({
      child: "synth#1",
      round: 1,
      model: "cheap",
      content: "syn-ref answer",
      messages: [
        {
          role: "tool",
          tool_call_id: "t1",
          content: `full value at ref://${toolSeq} and ref://sql_query.${namedSeq}/list`,
        },
      ],
      reads: [{ name: "facts", scope: 0, seq: null }],
    }),
  );
  insert.run(runId, "record", JSON.stringify({ child: "synth#1", childIndex: 0, value: "syn-ref answer", op: "set" }));
  const emitSeq = Number(
    insert.run(runId, "emit", JSON.stringify({ child: "synth-emit", value: "syn-ref answer" })).lastInsertRowid,
  );

  const p = reader.provenance(emitSeq, 1);
  assert.equal(p.match, "text", "the synthetic prompt matched by text");
  assert.equal(p.prompt!.seq, toolSeq + 1, "the synthetic llm_call is the prompt");
  assert.equal(p.refs.length, 2, "bare and named ref:// handles both resolve");
  const bySeq = new Map(p.refs.map((r) => [r.seq, r]));
  assert.equal(bySeq.get(toolSeq)?.text, "REF CONTENT", "the bare handle resolved");
  assert.equal(bySeq.get(namedSeq)?.text, "NAMED REF", "the named handle resolved");
  assert.equal(bySeq.get(namedSeq)?.kind, "tool_result");
  // A seq-less read from a root slot falls back to the latest write.
  assert.equal(p.pieces[0].name, "facts");
  assert.equal(p.pieces[0].resolved, "latest-write", "no seq link — latest write resolved it");
  assert.equal(p.pieces[0].writer?.seq, slotSeq("facts"));
  wdb.close();
}

reader.close();

// 6. pickEmitAnchor prefers text over index, and tolerates -1 (the UI's
//    single-output bubble).
{
  const list = [
    { seq: 1, text: "a" },
    { seq: 2, text: "b" },
    { seq: 3, text: "a" },
  ];
  assert.equal(pickEmitAnchor(list, 0, "a"), 2, "the last matching text wins");
  assert.equal(pickEmitAnchor(list, 0, ""), 0, "no text → the index");
  assert.equal(pickEmitAnchor(list, -1, ""), 2, "out-of-range → the last emit");
}

// 7. WebLog.findTurn resolves a turnId to its marker (the endpoint's turn lookup).
{
  const webLog = new WebLog(dbPath, (k) => k);
  webLog.writeTurnEnd({
    key: "web:prov",
    turnId: "turn-abc",
    runId,
    fromSeq: 0,
    toSeq: maxSeq,
    input: "ping",
    inputApp: "trunk",
    status: "done",
    error: null,
    output: "pong-1",
    emits: ["pong-1", "prov test", "guard: pong-1"],
    startedAt: 1,
    endedAt: 2,
  });
  const found = webLog.findTurn("turn-abc");
  assert.ok(found, "the marker was found by turnId");
  assert.equal(found!.runId, runId);
  assert.equal(webLog.findTurn("nope"), null, "an unknown turnId resolves to null");
  webLog.close();
}

// 8. when() renders the run id's timestamp.
assert.equal(when("2026-10-02_19-56-16-15"), "2026-10-02 19:56:16");

// 9. The endpoint: /api/provenance resolves the turn marker, the bubble's
//    emit row, and returns the walk — live or persisted, same shape.
{
  const mod = await import("../src/admin.ts");
  const port = await freePort();
  const server = mod.startAdmin({ port, workspaceDir: ws, agent });
  await events.once(server, "listening");
  try {
    const ok = await fetch(
      `http://127.0.0.1:${port}/api/provenance?turnId=turn-abc&bubble=-1&text=${encodeURIComponent("pong-1")}&depth=2`,
    );
    assert.equal(ok.status, 200, "the endpoint resolved the persisted turn");
    const body = (await ok.json()) as any;
    assert.equal(body.turnId, "turn-abc");
    assert.equal(body.match, "text");
    assert.equal(body.prompt.child.length > 0, true, "the prompt is named");
    assert.deepEqual(body.pieces.map((p: any) => p.name), ["facts", "derived", "input_1"]);
    assert.equal(body.depth, 2);
    assert.ok(body.emitCount >= 3, "the turn's emit list was scanned");

    const missing = await fetch(`http://127.0.0.1:${port}/api/provenance?turnId=nope&bubble=0`);
    assert.equal(missing.status, 404, "an unknown turn is a clean 404");
  } finally {
    server.close();
  }
  console.log("9. /api/provenance resolves a persisted turn end to end");
}

db.close();
katLogger.close();
await fs.rm(ws, { recursive: true, force: true });
console.log("provenance-test: all assertions passed");
process.exit(0);
