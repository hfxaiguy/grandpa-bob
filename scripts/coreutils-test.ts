/**
 * Virtual coreutils over the in-memory Platform — the browser replacement for
 * run_command. Run: `npm run test:coreutils`.
 */
import assert from "node:assert/strict";
import { createCoreutilsShell, runCommand } from "../src/platform/coreutils.js";
import { createMemoryPlatform } from "../src/platform/memory.js";

const platform = createMemoryPlatform({ root: "/workspace" });
const deps = { fs: platform.fs, path: platform.path, workspaceRoot: platform.workspaceRoot };
const run = (command: string, ...args: string[]) => runCommand(deps, command, args);
const shell = createCoreutilsShell(deps);

await platform.fs.mkdir("/workspace/notes", { recursive: true });
await platform.fs.writeFile("/workspace/notes/a.txt", "one\ntwo\nthree");
await platform.fs.writeFile("/workspace/notes/b.txt", "two\nthree\nfour");
await platform.fs.writeFile("/workspace/root.txt", "x\nx\ny");
await platform.fs.writeFile("/workspace/readme.md", "hello world");

assert.equal(await run("pwd"), "/workspace");
assert.equal(await run("echo", "hello", "world"), "hello world");
assert.equal(await shell.runCommand("echo", ["via", "shell"]), "via shell");
assert.equal(await run("ls", "."), "notes/\nreadme.md\nroot.txt");
assert.equal(await run("cat", "notes/a.txt"), "one\ntwo\nthree");
assert.equal(await run("head", "-n", "2", "notes/a.txt"), "one\ntwo");
assert.equal(await run("tail", "-n", "1", "notes/a.txt"), "three");
assert.equal(await run("wc", "-l", "notes/a.txt"), "3 notes/a.txt");
assert.equal(await run("sort", "root.txt"), "x\nx\ny");
assert.equal(await run("uniq", "root.txt"), "x\ny");
assert.match(await run("grep", "-n", "two", "."), /notes\/a\.txt:2:two/);
assert.match(await run("grep", "-n", "two", "."), /notes\/b\.txt:1:two/);
assert.match(await run("grep", "-i", "HELLO", "readme.md"), /hello world/);
assert.match(await run("find", ".", "-name", "*.txt"), /notes\/a\.txt/);
assert.match(await run("stat", "notes/a.txt"), /Type: file/);
assert.equal(await run("du", "notes/a.txt"), "13\tnotes/a.txt");
assert.equal(await run("diff", "notes/a.txt", "notes/a.txt"), "");
assert.match(await run("diff", "notes/a.txt", "notes/b.txt"), /differ/);
assert.ok(!Number.isNaN(Date.parse(await run("date"))));
assert.equal(await run("which", "cat"), "cat");

await run("mkdir", "newdir");
await run("touch", "newdir/empty.txt");
assert.equal(await run("ls", "newdir"), "empty.txt");

// sandbox: path-like args cannot escape the workspace
await assert.rejects(() => run("cat", "../secret"), /escapes workspace/);
await assert.rejects(() => run("cat", "/etc/passwd"), /escapes workspace/);

// unimplemented commands fail clearly
await assert.rejects(() => run("git", "status"), /not available in the browser/);
await assert.rejects(() => run("which", "git"), /unknown command/);

console.log("coreutils: ls/cat/head/tail/wc/grep/find/mkdir/touch/sort/uniq/stat/du/diff + sandbox OK");
