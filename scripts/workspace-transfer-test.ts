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
  buildPlatformArchive,
  fromBase64,
  importPlatformArchive,
  toBase64,
  validateWorkspaceArchive,
  type WorkspaceArchive,
} from "../web/src/workspace-transfer.js";
import { posixPath } from "../web/src/platform/paths.js";
import type { Platform } from "../web/src/platform/types.js";

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

// ── platform-based archives (desktop bridge mode) ────────────────────────
const bin = new Uint8Array([0, 1, 2, 255, 128]);

function fakePlatform(store: Map<string, Uint8Array>, binaryRead = true): Platform {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const fs = {
    async readFile(p: string): Promise<string> {
      const bytes = store.get(p);
      if (!bytes) throw new Error(`not found: ${p}`);
      return decoder.decode(bytes);
    },
    async writeFile(p: string, data: string | Uint8Array): Promise<void> {
      store.set(p, typeof data === "string" ? encoder.encode(data) : data);
    },
    async mkdir(): Promise<void> {},
    async readdir(dir: string) {
      const prefix = dir === "/" ? "/" : `${dir.replace(/\/+$/, "")}/`;
      const names = new Map<string, boolean>();
      for (const file of store.keys()) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        if (!name) continue;
        names.set(name, rest.length > 0 || names.get(name) === true);
      }
      return [...names].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    },
    async stat(p: string) {
      return { isFile: () => store.has(p), isDirectory: () => !store.has(p) };
    },
    async rm(p: string): Promise<void> {
      store.delete(p);
    },
    async rename(from: string, to: string): Promise<void> {
      const value = store.get(from);
      if (value) store.set(to, value);
      store.delete(from);
    },
    ...(binaryRead
      ? {
          async readFileBytes(p: string): Promise<Uint8Array> {
            const bytes = store.get(p);
            if (!bytes) throw new Error(`not found: ${p}`);
            return bytes;
          },
        }
      : {}),
  };
  return {
    kind: "browser",
    path: posixPath,
    fs: fs as unknown as Platform["fs"],
    workspaceRoot: "/",
  } as unknown as Platform;
}

const source = new Map<string, Uint8Array>([
  ["/app/trunk.prod.mjs", new TextEncoder().encode("export default {};")],
  ["/logs/grandma-kat.db", bin],
]);
const archive = await buildPlatformArchive(fakePlatform(source));
assert.deepEqual(
  archive.files.map((f) => f.path).sort(),
  ["workspace/app/trunk.prod.mjs", "workspace/logs/grandma-kat.db"],
  "bridge archives use the portable workspace/ prefix and nest directories",
);
const dbEntry = archive.files.find((f) => f.path.endsWith("grandma-kat.db"));
assert.deepEqual(fromBase64(dbEntry!.base64), bin, "binary files survive the bridge archive");

// Fallback platforms without readFileBytes still produce a valid archive.
const textOnly = await buildPlatformArchive(fakePlatform(source, false));
assert.ok(textOnly.files.length === 2);

// Import strips the prefix back off and writes into the platform workspace.
const target = new Map<string, Uint8Array>();
const written = await importPlatformArchive(fakePlatform(target), archive);
assert.equal(written, 2);
assert.deepEqual(target.get("/logs/grandma-kat.db"), bin);
assert.equal(new TextDecoder().decode(target.get("/app/trunk.prod.mjs")), "export default {};");
assert.ok(![...target.keys()].some((p) => p.includes("workspace")), "prefix is stripped on import");

// Traversal in an archive is refused.
await assert.rejects(
  () =>
    importPlatformArchive(fakePlatform(new Map()), {
      version: 1,
      createdAt: new Date().toISOString(),
      files: [{ path: "workspace/../escape", base64: "" }],
    }),
  /invalid archive path/,
);

console.log("workspace-transfer test: all assertions passed");
