/**
 * Emit values: the { text, buttons } shape chat surfaces render.
 *
 * A tree emit is a string, a { text } object, or a { text, buttons } object.
 * Buttons are a flat { label, value }[]; anything malformed is dropped so a
 * bad button can never reach a transport. Values without a text field keep
 * the JSON fallback, and emitText stays the text-only view.
 *
 * Run: npm run test:emit-value
 */
import assert from "node:assert/strict";
import { emitText, emitValue } from "../src/util/emit-text.js";

// ── 1. null/undefined have no text ──
assert.deepEqual(emitValue(null), { text: "" });
assert.deepEqual(emitValue(undefined), { text: "" });

// ── 2. strings pass through; objects take their text field ──
assert.deepEqual(emitValue("hello"), { text: "hello" });
assert.deepEqual(emitValue({ text: "hi" }), { text: "hi" });

// ── 3. buttons pass through, label and value trimmed ──
assert.deepEqual(
  emitValue({ text: "ready?", buttons: [{ label: " Yes ", value: " yes " }] }),
  { text: "ready?", buttons: [{ label: "Yes", value: "yes" }] },
);

// ── 4. malformed buttons are dropped, valid ones survive ──
assert.deepEqual(
  emitValue({
    text: "pick",
    buttons: [
      { label: "ok", value: "a" },
      { label: 1, value: "b" },
      "nope",
      null,
      { label: "x" },
      { label: "", value: "y" },
      { label: "z", value: " " },
      ["l", "v"],
    ],
  }),
  { text: "pick", buttons: [{ label: "ok", value: "a" }] },
);

// ── 5. no valid buttons → the buttons key is absent, not empty ──
assert.deepEqual(emitValue({ text: "plain", buttons: [] }), { text: "plain" });
assert.ok(!("buttons" in emitValue({ text: "plain", buttons: [] })));
assert.deepEqual(emitValue({ text: "plain", buttons: "yes" }), { text: "plain" });

// ── 6. values without a text field keep the JSON fallback ──
assert.deepEqual(emitValue({ foo: 1 }), { text: '{"foo":1}' });
assert.deepEqual(emitValue({ text: 123 }), { text: '{"text":123}' });
assert.deepEqual(emitValue([1, 2]), { text: "[1,2]" });
assert.deepEqual(emitValue(42), { text: "42" });
assert.deepEqual(emitValue(true), { text: "true" });

// ── 7. emitText is the text-only view, buttons ignored ──
assert.equal(emitText({ text: "hi", buttons: [{ label: "a", value: "b" }] }), "hi");
assert.equal(emitText("hi"), "hi");
assert.equal(emitText(null), "");

// ── 8. machine narration ({ machine }) is readable and tagged "machine" ──
assert.deepEqual(
  emitValue({ machine: { tree: "trunk", doing: "idle", at: "loop_input" } }),
  { text: "trunk idle at loop_input", level: "machine" },
);
assert.deepEqual(
  emitValue({ machine: { tree: "email", doing: "waiting", at: "reply", detail: "Send gate — draft to a@b" } }),
  { text: "Send gate — draft to a@b", level: "machine" },
);
assert.deepEqual(
  emitValue({ machine: { tree: "trunk", doing: "turn", priority: "Identify last enriched contact" } }),
  { text: "trunk turn — Identify last enriched contact", level: "machine" },
);

// ── 9. an explicit level rides along, overriding the machine default ──
assert.deepEqual(emitValue({ text: "hi", level: "debug" }), { text: "hi", level: "debug" });
assert.deepEqual(
  emitValue({ machine: { doing: "idle" }, level: "trace" }),
  { text: "idle", level: "trace" },
);

console.log("emit-value-test: emit value parsing OK");
