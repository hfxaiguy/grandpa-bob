/**
 * The pure half of the workspace archive (web/src/workspace-transfer.ts):
 * base64 round-trip, the shape guard Import relies on, and the JSON blob the
 * Export button downloads. The OPFS move itself needs a browser and is covered
 * by `npm --prefix web run smoke:browser`.
 * Run: `npm run test:workspace-transfer`.
 */
import assert from "node:assert/strict";
import {
  archiveToBlob,
  fromBase64,
  toBase64,
  validateWorkspaceArchive,
  type WorkspaceArchive,
} from "../web/src/workspace-transfer.js";

// ── base64 (binary-safe, chunked) ────────────────────────────────────────
assert.equal(toBase64(new Uint8Array()), "");
assert.equal(toBase64(new TextEncoder().encode("hello")), "aGVsbG8=");
assert.deepEqual(fromBase64("aGVsbG8="), new TextEncoder().encode("hello"));

// Every byte value, across the 0x8000 chunk boundary used by the encoder.
const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 256);
assert.deepEqual(fromBase64(toBase64(bytes)), bytes);

assert.throws(() => fromBase64("not base64!!"), /invalid base64/);

// ── archive shape guard ──────────────────────────────────────────────────
const valid: WorkspaceArchive = {
  version: 1,
  createdAt: "2026-10-21T12:00:00.000Z",
  files: [
    { path: "workspace/app/trunk.prod.mjs", base64: "ZXhwb3J0IGRlZmF1bHQge307" },
    { path: "workspace/logs/grandma-kat.db", base64: "" },
  ],
};
assert.deepEqual(validateWorkspaceArchive(JSON.parse(JSON.stringify(valid))), valid);

const bad: unknown[] = [
  null,
  "archive",
  {},
  { version: 2, createdAt: valid.createdAt, files: [] },
  { version: 1, files: [] },
  { version: 1, createdAt: valid.createdAt },
  { version: 1, createdAt: valid.createdAt, files: "x" },
  { version: 1, createdAt: valid.createdAt, files: [null] },
  { version: 1, createdAt: valid.createdAt, files: [{}] },
  { version: 1, createdAt: valid.createdAt, files: [{ path: "", base64: "" }] },
  { version: 1, createdAt: valid.createdAt, files: [{ path: "/etc/passwd", base64: "" }] },
  { version: 1, createdAt: valid.createdAt, files: [{ path: "workspace\\..\\escape", base64: "" }] },
  { version: 1, createdAt: valid.createdAt, files: [{ path: "workspace/../escape", base64: "" }] },
  { version: 1, createdAt: valid.createdAt, files: [{ path: "workspace/a.txt", base64: 1 }] },
];
for (const value of bad) {
  assert.throws(() => validateWorkspaceArchive(value), /archive|version|createdAt|files|path|base64/);
}

// ── download blob ────────────────────────────────────────────────────────
const blob = archiveToBlob(valid);
assert.equal(blob.type, "application/json");
assert.deepEqual(JSON.parse(await blob.text()), JSON.parse(JSON.stringify(valid)));

console.log("workspace-transfer test: all assertions passed");
