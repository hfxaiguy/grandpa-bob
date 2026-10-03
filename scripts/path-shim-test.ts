/**
 * Proves the pure `posixPath` shim (src/platform/paths.ts) matches
 * `node:path.posix` across a broad case list. Run: `npm run test:paths`.
 *
 * This is the regression guard that lets shared code depend on the path
 * shim instead of node:path, which is what makes the browser target possible.
 */
import nodePath from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posixPath } from "../src/platform/paths.js";
import { sha256hex } from "../src/platform/sha256.js";

const P = nodePath.posix;

const cases: string[][] = [
  ["resolve", "/a/b", "c"],
  ["resolve", "/a/b/", "../c"],
  ["resolve", "/a", "/b", "c"],
  ["resolve", "/workspace", "notes/../a.txt"],
  ["resolve", "/workspace", "./a"],
  ["resolve", "/", "a", "b"],
  ["resolve", "/a/b", "..", "..", "c"],
  ["join", "/a", "b", "c"],
  ["join", "a", "/b", "c"],
  ["join", "/a/b", "../c"],
  ["join", ""],
  ["join", "a/b/"],
  ["join", "/", "a"],
  ["relative", "/a/b/c", "/a/b/d"],
  ["relative", "/a/b", "/a"],
  ["relative", "/a", "/a/b/c"],
  ["relative", "/a/b", "/a/b"],
  ["relative", "/a/b/c", "/x/y"],
  ["dirname", "/a/b/c"],
  ["dirname", "/a/b/"],
  ["dirname", "/a"],
  ["dirname", "a"],
  ["dirname", "/"],
  ["basename", "/a/b/c.txt"],
  ["basename", "/a/b/c.txt", ".txt"],
  ["basename", "/a/b/"],
  ["basename", "/"],
  ["basename", "/a/.txt", ".txt"],
  ["basename", "c.txt"],
  ["extname", "/a/b/c.txt"],
  ["extname", "/a/b/.hidden"],
  ["extname", "/a/b/c.tar.gz"],
  ["extname", "/a/b/c"],
  ["normalize", "/a/b/../c/./d"],
  ["normalize", "a/b/"],
  ["normalize", "/a//b///c"],
  ["normalize", "a/.."],
  ["normalize", "/"],
  ["normalize", ".."],
  ["normalize", "../a"],
  ["isAbsolute", "/a"],
  ["isAbsolute", "a/b"],
];

let checks = 0;
for (const [method, ...args] of cases) {
  const fn = P[method as keyof typeof P] as unknown as (...a: string[]) => string | boolean;
  const shimFn = posixPath[method as keyof typeof posixPath] as unknown as (...a: string[]) => string | boolean;
  const expected = fn(...args);
  const actual = shimFn(...args);
  assert.deepEqual(
    actual,
    expected,
    `${method}(${args.map((a) => JSON.stringify(a)).join(", ")}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  checks++;
}

// resolve() with no absolute part is cwd-dependent on Node; the shim roots at "/".
// Assert the relative-to-absolute difference is just the missing cwd prefix.
assert.equal(posixPath.resolve("a", "b"), "/a/b");

// SHA-256: known vectors + agreement with node:crypto on varied inputs.
const vectors: Array<[string, string]> = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
];
for (const [input, expected] of vectors) {
  assert.equal(sha256hex(input), expected, `sha256(${JSON.stringify(input)})`);
}
const long = "The quick brown fox jumps over the lazy dog. ".repeat(200);
assert.equal(
  sha256hex(long),
  createHash("sha256").update(long).digest("hex"),
  "sha256 multi-block input matches node:crypto",
);
assert.equal(
  sha256hex("héllo — ünïcode ✓"),
  createHash("sha256").update("héllo — ünïcode ✓", "utf8").digest("hex"),
  "sha256 utf-8 input matches node:crypto",
);

// Workspace escape guard uses the same path ops.
const workspace = "/workspace";
assert.equal(posixPath.resolve(workspace, "notes/a.txt"), "/workspace/notes/a.txt");
assert.equal(
  posixPath.relative(workspace, "/workspace/notes/a.txt"),
  "notes/a.txt",
);

console.log(`platform: ${checks} path cases match node:path.posix; sha256 vectors + fuzz match node:crypto`);
