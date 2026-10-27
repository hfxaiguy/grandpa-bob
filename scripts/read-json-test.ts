/**
 * read_json: strict parsing, the three sources (path / text / ref), the
 * /-separated walk (`at`), and the Node registry round-trip (sandbox, errors,
 * ref ctx forwarding).
 *
 * The shared module (`src/tools/json.ts`) is platform-free and the browser
 * worker imports the same code; this test exercises it over the Node adapter.
 *
 * Run: `npm run test:read-json`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNodePlatform } from "../src/platform/node.js";
import { ToolRegistry } from "../src/tools/index.js";
import {
  MAX_JSON_CHARS,
  jsonPathSteps,
  parseJsonContent,
  readJsonValue,
  walkJson,
} from "../src/tools/json.js";

// ── parser ───────────────────────────────────────────────────────────────
{
  assert.deepEqual(parseJsonContent('{"a":[1,2,{"b":true}]}'), { a: [1, 2, { b: true }] });
  assert.deepEqual(parseJsonContent('\uFEFF  [1, 2]\n'), [1, 2], "BOM + surrounding whitespace");
  assert.equal(parseJsonContent('"hi"'), "hi", "a JSON string value");
  assert.equal(parseJsonContent("null"), null);
  assert.equal(parseJsonContent("5"), 5);

  assert.throws(() => parseJsonContent(""), /content is empty/);
  assert.throws(() => parseJsonContent("   \n"), /content is empty/);
  assert.throws(() => parseJsonContent('{"a":}'), /not valid JSON/);
  assert.throws(() => parseJsonContent("<html>nope</html>"), /not valid JSON/);
  assert.throws(
    () => parseJsonContent('{"a":1}\n{"a":2}\n'),
    /looks like JSONL \(2 lines/,
    "multi-line JSON values are called out as JSONL",
  );
  assert.throws(
    () => parseJsonContent("1".repeat(MAX_JSON_CHARS + 1)),
    /too large to parse/,
  );
  // One line that fails on its own is a normal syntax error, not JSONL.
  assert.throws(() => parseJsonContent('{"a":1}\nnot json'), /not valid JSON/);
}

// ── path walk (same dialect as inspect_memory / ref handles) ─────────────
{
  const value = { rows: [{ email: "ada@example.com" }, { email: "grace@example.com" }], n: null };
  assert.deepEqual(jsonPathSteps("rows/0/email"), ["rows", "0", "email"]);
  assert.deepEqual(jsonPathSteps("/rows//1/"), ["rows", "1"], "empty segments are dropped");
  assert.deepEqual(jsonPathSteps(["rows", 0]), ["rows", "0"], "array form, like inspect_memory");
  assert.deepEqual(jsonPathSteps(undefined), []);
  assert.throws(() => jsonPathSteps(5), /at must be a/);

  assert.equal(walkJson(value, ["rows", "1", "email"]), "grace@example.com");
  assert.equal(walkJson(value, ["n"]), null, "an explicit null is a value, not a miss");
  assert.equal(walkJson(value, ["rows", "5"]), undefined, "an out-of-range index misses");
  assert.equal(walkJson(value, ["missing"]), undefined);

  assert.deepEqual(
    await readJsonValue({ text: JSON.stringify(value), at: "rows/0/email" }, { readFile: noFile }),
    { json: "ada@example.com", at: "rows/0/email" },
  );
}

function noFile(): Promise<string> {
  throw new Error("no file expected in this case");
}

// ── the Node registry: path source, sandbox, errors ──────────────────────
const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-json-"));
const platform = createNodePlatform(workspace);
const registry = new ToolRegistry(workspace, []);
const abs = (name: string): string => platform.path.join(workspace, name);
const call = (args: Record<string, unknown>, ctx?: { readRef?: (ref: string) => unknown }) =>
  registry.dispatch("read_json", JSON.stringify(args), ctx);

try {
  await platform.fs.writeFile(
    abs("config.json"),
    JSON.stringify({ users: [{ email: "ada@example.com", tags: ["a", "b"] }], count: 1 }, null, 2),
  );
  await platform.fs.writeFile(abs("list.jsonl"), '{"a":1}\n{"a":2}\n');
  await platform.fs.writeFile(abs("broken.json"), '{"a":');

  assert.ok(
    registry.definitions.some(
      (d) => d.type === "function" && d.function.name === "read_json",
    ),
    "read_json is in the tool schema list",
  );

  assert.deepEqual(await call({ path: "config.json" }), {
    json: { users: [{ email: "ada@example.com", tags: ["a", "b"] }], count: 1 },
  });
  assert.deepEqual(await call({ path: "config.json", at: "users/0/email" }), {
    json: "ada@example.com",
    at: "users/0/email",
  });
  assert.deepEqual(await call({ path: "config.json", at: ["users", 0, "tags", 1] }), {
    json: "b",
    at: "users/0/tags/1",
  });
  assert.match(String(await call({ path: "config.json", at: "users/3" })), /^error: at "users\/3" not found/);
  assert.match(String(await call({ path: "missing.json" })), /^error: not found: missing\.json/);
  assert.match(String(await call({ path: "../escape.json" })), /escapes workspace/);
  assert.match(String(await call({ path: "/etc/passwd" })), /escapes workspace/);
  assert.match(String(await call({ path: "list.jsonl" })), /looks like JSONL/);
  assert.match(String(await call({ path: "broken.json" })), /not valid JSON/);

  // A directory that exists gets the "not a file" hint instead of a read error.
  await platform.fs.mkdir(abs("adir"), { recursive: true });
  assert.match(String(await call({ path: "adir" })), /^error: not a file: adir/);

  // ── text source + source XOR ──────────────────────────────────────────
  assert.deepEqual(await call({ text: '{"a":{"b":7}}' }), { json: { a: { b: 7 } } });
  assert.deepEqual(await call({ text: '{"a":{"b":7}}', at: "a/b" }), { json: 7, at: "a/b" });
  assert.match(String(await call({ text: "not json" })), /^error: not valid JSON/);
  assert.match(String(await call({})), /^error: missing source/);
  assert.match(
    String(await call({ path: "config.json", text: "{}" })),
    /pass exactly one of "path", "text" or "ref" \(got path, text\)/,
  );

  // ── ref source: engine ctx forwarding, string payloads, sub-paths ─────
  const stored: Record<string, unknown> = {
    "ref://tool_calls.9": { rows: [{ email: "ada@example.com" }] },
    "ref://api.12": '{"answer":42,"items":[{"id":"x"},{"id":"y"}]}',
    "ref://note.3": "just some plain text",
  };
  const readRef = (ref: string): unknown => stored[ref];

  assert.deepEqual(await call({ ref: "ref://tool_calls.9" }, { readRef }), {
    json: { rows: [{ email: "ada@example.com" }] },
  });
  assert.deepEqual(await call({ ref: "ref://tool_calls.9", at: "rows/0/email" }, { readRef }), {
    json: "ada@example.com",
    at: "rows/0/email",
  });
  assert.deepEqual(
    await call({ ref: "ref://api.12", at: "items/1/id" }, { readRef }),
    { json: "y", at: "items/1/id" },
    "a ref holding a JSON string is parsed, then walked",
  );
  assert.match(String(await call({ ref: "ref://note.3" }, { readRef })), /^error: .*not valid JSON/);
  assert.match(
    String(await call({ ref: "ref://api.12" })),
    /^error: "ref" needs a live run context/,
    "without the engine ctx a ref is refused, not silently skipped",
  );
  assert.match(String(await call({ ref: "ref://tool_calls.9", at: "rows/9" }, { readRef })), /not found/);

  // read_json carries prompt guidance assembled by the shared module.
  assert.match(registry.toolGuide(), /READING JSON/);

  console.log("read_json: strict parsing, path/text/ref sources, at-walks and registry wiring OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
