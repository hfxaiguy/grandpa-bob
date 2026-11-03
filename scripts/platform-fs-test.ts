/**
 * Proves the shared file tools run over a non-Node `Platform` (in-memory),
 * which is the whole point of the adapter seam: the same `FileTools` class
 * will run over OPFS in the browser. Run: `npm run test:platform`.
 */
import assert from "node:assert/strict";
import { FileTools } from "../web/src/tools/files.js";
import { createMemoryPlatform } from "../web/src/platform/memory.js";

const commits: Array<{ paths: string[]; message: string }> = [];
const platform = createMemoryPlatform({
  autoCommit: async (paths, message) => {
    commits.push({ paths, message });
    return "abc1234";
  },
});
const files = new FileTools(platform);

// write_file creates parent dirs and auto-commits with the workspace-relative path.
const written = await files.writeFile("notes/hello.txt", "hello world");
assert.match(written, /wrote 11 chars to notes\/hello\.txt \(commit: abc1234\)/);
assert.deepEqual(commits.at(-1), {
  paths: ["notes/hello.txt"],
  message: "agent(write_file): notes/hello.txt",
});

// read_file + list_files
assert.equal(await files.readFile("notes/hello.txt"), "hello world");
assert.equal(await files.listFiles(".", true), "notes/\nnotes/hello.txt");

// edit_file: unique replacement
await files.editFile("notes/hello.txt", "world", "grandma");
assert.equal(await files.readFile("notes/hello.txt"), "hello grandma");
assert.equal(commits.at(-1)?.message, "agent(edit_file): notes/hello.txt");

// edit_file: ambiguous match is rejected, replace_all fixes it
await files.writeFile("notes/dup.txt", "x x x");
await assert.rejects(() => files.editFile("notes/dup.txt", "x", "y"), /occurs 3 times/);
await files.editFile("notes/dup.txt", "x", "y", true);
assert.equal(await files.readFile("notes/dup.txt"), "y y y");

// delete_file
await files.deleteFile("notes/dup.txt");
await assert.rejects(() => files.readFile("notes/dup.txt"), /not found/);

// copy_file: copies content, commits the destination, and refuses to clobber
await files.writeFile("notes/copy.txt", "copy me");
await files.copyFile("notes/copy.txt", "notes/copied.txt");
assert.equal(await files.readFile("notes/copied.txt"), "copy me");
assert.equal(commits.at(-1)?.message, "agent(copy_file): notes/copied.txt");
await assert.rejects(() => files.copyFile("notes/copy.txt", "notes/copied.txt"), /destination exists/);
await files.copyFile("notes/copy.txt", "notes/copied.txt", true);
assert.equal(await files.readFile("notes/copied.txt"), "copy me");

// the workspace sandbox still rejects escapes
await assert.rejects(() => files.writeFile("../escape.txt", "nope"), /escapes workspace/);
await assert.rejects(() => files.readFile("../../etc/passwd"), /escapes workspace/);

// independence from the Node filesystem: nothing was written under a real path
assert.equal(commits.length, 8, "one commit per mutation");

// read_file ranges: a big file is readable in chunks, with an explicit next
// offset instead of a silent 100k cut (the old behaviour made a 5.8 MB mbox
// look like a 100k file).
const big = "0123456789".repeat(10_001); // 100_010 chars
await files.writeFile("notes/big.txt", big);
const firstChunk = await files.readFile("notes/big.txt");
assert.ok(firstChunk.startsWith("0123456789"));
assert.match(firstChunk, /read chars 0\.\.100000 of 100010; next offset 100000/);
const lastChunk = await files.readFile("notes/big.txt", { offset: 100_000 });
assert.equal(
  lastChunk,
  big.slice(100_000) + "\n… (read chars 100000..100010 of 100010; end of file)",
);
const window = await files.readFile("notes/big.txt", { offset: 10, limit: 5 });
assert.equal(
  window,
  big.slice(10, 15) + "\n… (read chars 10..15 of 100010; next offset 15)",
);
await assert.rejects(() => files.readFile("notes/big.txt", { offset: 100_010 }), /past the end/);
// An empty file still reads normally; only a positive offset is past its end.
await files.writeFile("notes/empty.txt", "");
assert.equal(await files.readFile("notes/empty.txt"), "(empty file)");
await assert.rejects(() => files.readFile("notes/empty.txt", { offset: 1 }), /past the end/);

// ── byte fidelity on the real Node adapter ─────────────────────────────
// The memory platform above proves the tool seam; this proves copy_file is
// genuinely binary-safe (invalid UTF-8 bytes survive unchanged).
import { mkdtemp, readFile as readBytes, writeFile as writeBytes, rm } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { createNodePlatform } from "../src/platform/node.js";

const dir = await mkdtemp(nodePath.join(os.tmpdir(), "bob-copy-"));
try {
  const bytes = Uint8Array.from([0x00, 0xff, 0x01, 0xfe, 0x50, 0x4b, 0x03, 0x04, 0x80, 0x00, 0x7f]);
  await writeBytes(nodePath.join(dir, "blob.bin"), bytes);
  const nodePlatform = createNodePlatform(dir);
  await nodePlatform.git.ensureRepo();
  await new FileTools(nodePlatform).copyFile("blob.bin", "blob-copy.bin");
  const got = new Uint8Array(await readBytes(nodePath.join(dir, "blob-copy.bin")));
  assert.deepEqual(got, bytes, "copy_file preserves every byte");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("platform-fs: FileTools runs over an in-memory Platform (adapter seam OK) and copies bytes intact");
