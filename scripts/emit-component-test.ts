/**
 * Emit components: the sandboxed guest document.
 *
 * A component is workspace JavaScript, so the host builds a self-contained
 * document for `sandbox="allow-scripts"` (opaque origin). The source is passed
 * to the guest as a base64 data URL, props/theme as escaped JSON, and the only
 * way back is postMessage.
 *
 * Run: npm run test:emit-component
 */
import assert from "node:assert/strict";
import { base64Utf8, componentDoc } from "../ui/src/emit-component.ts";

// ── 1. UTF-8 survives the base64 round-trip (names are not all ASCII) ──
const source = [
  "export default function render(el, props) {",
  "  el.textContent = props.name + ' — ' + props.emoji;",
  "}",
].join("\n");
assert.equal(Buffer.from(base64Utf8(source), "base64").toString("utf8"), source);
assert.equal(Buffer.from(base64Utf8("Zoë — ☕"), "base64").toString("utf8"), "Zoë — ☕");

// ── 2. the guest imports the source and gets props + theme ──
const doc = componentDoc(
  source,
  { name: "Keith", emoji: "☕", note: "</script><script>alert(1)</script>" },
  { "--bob-fg": "#dbe4f5" },
);
assert.ok(doc.startsWith("<!doctype html>"), "a complete document");
assert.ok(doc.includes(`data:text/javascript;base64,${base64Utf8(source)}`), "source as a data URL");
assert.ok(doc.includes('"name":"Keith"'), "props are embedded");
assert.ok(doc.includes('"--bob-fg":"#dbe4f5"'), "theme is embedded");
assert.ok(doc.includes("bob-component-size"), "the guest reports its height");
assert.ok(doc.includes("bob-component-action"), "the guest can send a reply");
assert.ok(doc.includes("bob-component-error"), "render failures surface to the host");

// ── 3. props can never close the script element (XSS escape hatch) ──
assert.ok(!doc.includes("</script><script>alert(1)</script>"), "props JSON escapes <");
assert.ok(doc.includes("\\u003c/script"), "the escape is visible in the document");
assert.ok(!doc.includes("allow-same-origin"), "the document itself never grants same-origin");

// ── 4. a missing/undefined props value is still valid JSON ──
const bare = componentDoc("export default () => {};", undefined);
assert.ok(bare.includes("const INITIAL_PROPS = null;"), "undefined props normalize to null");

console.log("emit-component-test: sandboxed component document OK");
