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
 * Run: `npm run test:read-runs-args`.
 */
import assert from "node:assert/strict";
import {
  annotateReadRunsResult,
  normalizeReadRunsArgs,
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

console.log("read-runs-args: encoded filters, numeric strings, and max_seq annotations OK");
