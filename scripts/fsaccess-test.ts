/**
 * Verifies the File System Access adapter (`web/src/platform/handle-fs.ts`)
 * and its isomorphic-git bridge against an in-memory implementation of the
 * browser's `FileSystemDirectoryHandle` API.
 *
 *   npm run test:fsaccess
 *
 * The handle API is the only thing the real adapter depends on, so these are
 * the same code paths that run against a picked folder in Chromium.
 */
import assert from "node:assert/strict";
import { createHandleFs } from "../web/src/platform/handle-fs";
import { createHandleGit } from "../web/src/platform/git-handle";

// ── an in-memory FileSystemDirectoryHandle ────────────────────────────

type Entry =
  | { kind: "file"; data: Uint8Array; mtime: number }
  | { kind: "dir"; children: Map<string, Entry> };

function copyBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

function decode(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : copyBytes(data);
}

class MockFileHandle {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    private readonly entry: Extract<Entry, { kind: "file" }>,
  ) {}

  async getFile() {
    const bytes = this.entry.data;
    return {
      size: bytes.length,
      lastModified: this.entry.mtime,
      arrayBuffer: async () => copyBytes(bytes).buffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async createWritable() {
    let pending: Uint8Array | null = null;
    return {
      write: async (data: string | Uint8Array | ArrayBuffer) => {
        pending =
          typeof data === "string"
            ? new TextEncoder().encode(data)
            : data instanceof Uint8Array
              ? copyBytes(data)
              : copyBytes(new Uint8Array(data.slice(0)));
      },
      close: async () => {
        if (!pending) throw new Error("no data written");
        this.entry.data = pending;
        this.entry.mtime = Date.now();
      },
    };
  }
}

class MockDirHandle {
  readonly kind = "directory" as const;
  constructor(
    readonly name: string,
    private readonly entry: Extract<Entry, { kind: "dir" }>,
  ) {}

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<MockFileHandle> {
    let child = this.entry.children.get(name);
    if (!child) {
      if (!opts.create) throw new DOMException(`not found: ${name}`, "NotFoundError");
      child = { kind: "file", data: new Uint8Array(), mtime: Date.now() };
      this.entry.children.set(name, child);
    }
    if (child.kind !== "file") throw new DOMException(`not a file: ${name}`, "TypeMismatchError");
    return new MockFileHandle(name, child);
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<MockDirHandle> {
    let child = this.entry.children.get(name);
    if (!child) {
      if (!opts.create) throw new DOMException(`not found: ${name}`, "NotFoundError");
      child = { kind: "dir", children: new Map() };
      this.entry.children.set(name, child);
    }
    if (child.kind !== "dir") throw new DOMException(`not a directory: ${name}`, "TypeMismatchError");
    return new MockDirHandle(name, child);
  }

  async removeEntry(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const child = this.entry.children.get(name);
    if (!child) throw new DOMException(`not found: ${name}`, "NotFoundError");
    if (child.kind === "dir" && child.children.size > 0 && !opts.recursive) {
      throw new DOMException(`directory not empty: ${name}`, "InvalidModificationError");
    }
    this.entry.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, MockFileHandle | MockDirHandle]> {
    for (const [name, child] of [...this.entry.children]) {
      yield [
        name,
        child.kind === "dir" ? new MockDirHandle(name, child) : new MockFileHandle(name, child),
      ];
    }
  }
}

function memoryRoot(): MockDirHandle {
  return new MockDirHandle("workspace", { kind: "dir", children: new Map() });
}

// ── filesystem semantics ─────────────────────────────────────────────

async function testFilesystem(): Promise<void> {
  const root = memoryRoot();
  const fs = createHandleFs(async () => root as unknown as FileSystemDirectoryHandle);

  await fs.mkdir("/notes", { recursive: true });
  await fs.writeFile("/notes/hello.md", "hello bob\n");
  assert.equal(await fs.readFile("/notes/hello.md"), "hello bob\n");

  const detail = await fs.statDetail("/notes/hello.md");
  assert.equal(detail.isFile, true);
  assert.equal(detail.size, 10);
  assert.ok(detail.mtimeMs > 0);

  const entries = await fs.readdir("/notes", { withFileTypes: true });
  assert.deepEqual(entries.map((e) => e.name), ["hello.md"]);

  await fs.writeFile("/notes/binary.dat", new Uint8Array([0, 1, 2, 255]));
  assert.deepEqual([...(await fs.readFileBytes("/notes/binary.dat"))], [0, 1, 2, 255]);

  await fs.rename("/notes/hello.md", "/notes/renamed.md");
  assert.equal(await fs.readFile("/notes/renamed.md"), "hello bob\n");
  await assert.rejects(() => fs.stat("/notes/hello.md"));

  await fs.rm("/notes");
  await assert.rejects(() => fs.readdir("/notes", { withFileTypes: true }));
  console.log("✓ handle filesystem: write/read/stat/readdir/rename/rm");
}

// ── git over the handle filesystem ───────────────────────────────────

async function testGit(): Promise<void> {
  const root = memoryRoot();
  const fs = createHandleFs(async () => root as unknown as FileSystemDirectoryHandle);
  const git = createHandleGit(fs, "/");

  await git.ensureRepo();
  await fs.writeFile("/hello.txt", "hi\n");
  const commit = await git.autoCommit(["hello.txt"], "first commit");
  assert.match(commit, /^[0-9a-f]{7}$/, "autoCommit returns a short sha");

  const log = (await git.log!(3)) as Array<{ oid: string; message: string }>;
  assert.equal(log[0].message, "first commit");

  const status = (await git.status!()) as { changes: unknown[] };
  assert.equal(status.changes.length, 0, "working tree clean after commit");
  console.log("✓ handle git: init/commit/log/status");
}

async function main(): Promise<void> {
  await testFilesystem();
  await testGit();
  console.log("fsaccess adapter: ok");
}

main().catch((err) => {
  console.error("fsaccess adapter: FAILED");
  console.error(err);
  process.exitCode = 1;
});
