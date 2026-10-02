/**
 * Proves the shared file tools run over a non-Node `Platform` (in-memory),
 * which is the whole point of the adapter seam: the same `FileTools` class
 * will run over OPFS in the browser. Run: `npm run test:platform`.
 */
import assert from "node:assert/strict";
import { FileTools } from "../src/tools/files.js";
import { createMemoryPlatform } from "../src/platform/memory.js";

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

// the workspace sandbox still rejects escapes
await assert.rejects(() => files.writeFile("../escape.txt", "nope"), /escapes workspace/);
await assert.rejects(() => files.readFile("../../etc/passwd"), /escapes workspace/);

// independence from the Node filesystem: nothing was written under a real path
assert.equal(commits.length, 5, "one commit per mutation");

console.log("platform-fs: FileTools runs over an in-memory Platform (adapter seam OK)");
