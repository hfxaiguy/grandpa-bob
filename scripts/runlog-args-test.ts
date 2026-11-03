/**
 * read_runs must survive the argument shapes models actually send.
 *
 * The insight run that concluded "the knit failures aren't in the log" sent
 * `type` as `"[\"tool_call\", \"tool_error\", \"llm_error\"]"` — a string, not an
 * array. read_runs took it literally, matched no kind, and returned rows: [].
 * The empty result was then read as absence. These helpers normalize that
 * shape, and annotate condensed results with the log's current max seq so an
 * empty id probe is not mistaken for the end of the log.
 *
 * A later insight run concluded "none of the rows records the input string":
 * the engine renders a tool row's `result` as its readable text and drops
 * `args`, so the call's input looked unrecorded. Attach it back here.
 *
 * Run: `npm run test:read-runs-args`.
 */
import assert from "node:assert/strict";
import {
  attachToolInputs,
  annotateReadRunsResult,
  normalizeReadRunsArgs,
  resultSeqs,
  TOOL_KINDS,
  toolInputFromContent,
} from "../web/src/agent/runlog-args.ts";

// A JSON-encoded list becomes the list; the original object is untouched.
const raw = { type: '["tool_call", "tool_error", "llm_error"]', limit: "5", id: "2000" };
const list = normalizeReadRunsArgs(raw);
assert.deepEqual(
  list.args.type,
  ["tool_call", "tool_error", "llm_error"],
  "a JSON-encoded list is interpreted as the kinds it names",
);
assert.equal(list.args.limit, 5, "numeric-string limit is coerced");
assert.equal(list.args.id, 2000, "numeric-string id is coerced");
assert.equal(list.warnings.length, 1, "one warning for the encoded type");
assert.match(list.warnings[0] ?? "", /type arrived as a JSON string/);
assert.equal(raw.type, '["tool_call", "tool_error", "llm_error"]', "the input is not mutated");

// A quoted single kind is unwrapped; an actual single kind is left alone.
assert.deepEqual(normalizeReadRunsArgs({ type: '"human"' }).args.type, ["human"]);
assert.deepEqual(normalizeReadRunsArgs({ type: '"human"' }).warnings, [
  'type arrived as a JSON string; interpreted it as ["human"].',
]);
const plain = normalizeReadRunsArgs({ type: "emit" });
assert.deepEqual(plain.args.type, ["emit"], "a real kind is unchanged");
assert.deepEqual(plain.warnings, [], "a real kind produces no warning");

// Arrays are kept (and de-duplicated) without a warning.
const array = normalizeReadRunsArgs({ type: ["emit", "emit", "human"] });
assert.deepEqual(array.args.type, ["emit", "human"]);
assert.deepEqual(array.warnings, []);

// An empty filtered result carries the filter, the edge, and the warning.
const empty = annotateReadRunsResult(
  { rows: [] },
  list.args,
  9558,
  list.warnings,
) as { rows: unknown[]; meta?: { max_seq?: number }; note?: string };
assert.equal(empty.meta?.max_seq, 9558, "condensed results carry the log edge");
assert.match(empty.note ?? "", /0 rows matched type/);
assert.match(empty.note ?? "", /seq 9558/);
assert.match(empty.note ?? "", /type arrived as a JSON string/);

// A non-empty result keeps the edge but gets no empty-filter note.
const hit = annotateReadRunsResult({ rows: [{ seq: 9 }] }, { type: ["emit"] }, 9558) as {
  meta?: { max_seq?: number };
  note?: string;
};
assert.equal(hit.meta?.max_seq, 9558);
assert.equal(hit.note, undefined);

// Expanded/deps/readers results are untouched.
const expanded = { run_id: "r", emit: { seq: 1 }, events: [] };
assert.equal(annotateReadRunsResult(expanded, { type: ["emit"] }, 10), expanded);

// ── tool inputs ────────────────────────────────────────────────────────
// The engine stores a tool event as {child, tool, args, result}; its readable
// line is the result, so a caller never saw what the tool was called with.
const call = JSON.stringify({
  child: "handin",
  tool: "set_caller_list",
  args: { ref: "ref://rows.24368", walk_name: "Enriched companies", note: "connected people" },
  result: { list: 16, walk: "Enriched companies", onTable: "Warren Willoughby", mode: "start" },
});
const condensed = {
  rows: [
    { seq: 24370, kind: "tool_call", child: "handin", text: '{"list":16,"mode":"start"}' },
    { seq: 24367, kind: "record", child: "handin", text: "selection" },
  ],
};
assert.deepEqual(resultSeqs(condensed), [24370, 24367], "every shaped row seq is read back");
assert.deepEqual(resultSeqs(condensed, TOOL_KINDS), [24370], "only tool rows need a content lookup");
assert.deepEqual(resultSeqs({ run_id: "r", emit: { seq: 1 }, events: [{ seq: 9 }] }).sort(), [1, 9]);
assert.deepEqual(resultSeqs(null), []);

const enriched = attachToolInputs(condensed, [
  { seq: 24370, content: call },
  { seq: 24367, content: '{"value":{"rows":16}}' },
]) as { rows: Array<{ seq: number; tool?: string; args?: string; text: string }> };
assert.equal(enriched.rows[0]?.tool, "set_caller_list", "the tool name comes back with the input");
assert.equal(
  enriched.rows[0]?.args,
  '{"ref":"ref://rows.24368","walk_name":"Enriched companies","note":"connected people"}',
  "the args the call was invoked with are attached",
);
assert.equal(
  enriched.rows[0]?.text,
  condensed.rows[0]?.text,
  "text still reads the result — the input is added, not substituted",
);
assert.equal(enriched.rows[1]?.args, undefined, "a record has no tool input");
assert.equal(condensed.rows[0]?.args, undefined, "the input result object is not mutated");

// Expanded traces get the same fields on their events (and the emit anchor).
const trace = {
  run_id: "r",
  emit: { seq: 24370, kind: "tool_call", text: '{"list":16}' },
  events: [{ seq: 24370, kind: "tool_call", child: "handin", snippet: '{"list":16}' }],
};
const traced = attachToolInputs(trace, [{ seq: 24370, content: call }]) as {
  emit: { args?: string };
  events: Array<{ tool?: string; args?: string }>;
};
assert.match(traced.emit.args ?? "", /ref:\/\/rows\.24368/);
assert.equal(traced.events[0]?.tool, "set_caller_list");
assert.match(traced.events[0]?.args ?? "", /ref:\/\/rows\.24368/);

// A parsed object works as well as the JSON string the DB returns.
assert.deepEqual(toolInputFromContent({ tool: "show_next", args: {} }), {
  tool: "show_next",
  args: "{}",
});
assert.equal(toolInputFromContent({ value: 1 }), null, "non-tool rows have no input");
assert.equal(toolInputFromContent("not json"), null, "unparseable content is skipped");

// The args line is bounded like the engine's readable text, and the ref that
// identifies the selection sits at the front.
const long = toolInputFromContent({ tool: "sql_query", args: { query: "SELECT 1 ".repeat(200) } });
assert.ok((long?.args ?? "").length <= 501, "long args are truncated");
assert.ok((long?.args ?? "").endsWith("…"));

console.log("read-runs-args: encoded filters, numeric strings, max_seq annotations, and tool inputs OK");
