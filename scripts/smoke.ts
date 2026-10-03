/**
 * Offline smoke test: file tools, git auto-commit, sandboxing, shell allowlist.
 * No Telegram token or LLM required. Run: npm run smoke
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileTools } from "../src/tools/files.js";
import { createNodePlatform } from "../src/platform/node.js";
import { ShellTools } from "../src/tools/shell.js";
import { ensureRepo, git } from "../src/tools/git.js";
import { ExaSearchTools } from "../src/tools/websearch.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "grandma-smoke-"));
await ensureRepo(ws);
const files = new FileTools(createNodePlatform(ws, ["ls", "git", "echo"]));
const shell = new ShellTools(ws, ["ls", "git", "echo"]);

// write_file creates parent dirs and auto-commits
await files.writeFile("notes/hello.txt", "hello world");
let log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(write_file\): notes\/hello\.txt/, "write_file should auto-commit");

// read_file
assert.equal(await files.readFile("notes/hello.txt"), "hello world");

// edit_file + auto-commit, tree stays clean
await files.editFile("notes/hello.txt", "world", "grandma");
assert.equal(await files.readFile("notes/hello.txt"), "hello grandma");
log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(edit_file\): notes\/hello\.txt/, "edit_file should auto-commit");
assert.equal((await git(ws, ["status", "--porcelain"])).trim(), "", "working tree must be clean after auto-commit");

// list_files
const listing = await files.listFiles(".");
assert.match(listing, /notes\//);
assert.match(listing, /notes\/hello\.txt/);

// edit_file errors: missing string, ambiguous string
await assert.rejects(() => files.editFile("notes/hello.txt", "zzz", "x"), /not found/);
await files.writeFile("dup.txt", "a a a");
await assert.rejects(() => files.editFile("dup.txt", "a", "b"), /occurs 3 times/);
await files.editFile("dup.txt", "a", "b", true);
assert.equal(await files.readFile("dup.txt"), "b b b");

// sandbox escapes are rejected
await assert.rejects(() => files.writeFile("../escape.txt", "nope"), /escapes workspace/);
await assert.rejects(() => files.readFile("/etc/passwd"), /escapes workspace/);

// delete_file + auto-commit
await files.deleteFile("dup.txt");
log = await git(ws, ["log", "--oneline"]);
assert.match(log, /agent\(delete_file\): dup\.txt/, "delete_file should auto-commit");

// run_command: allowlist + git deny list
const out = await shell.runCommand("echo", ["hi"]);
assert.match(out, /hi/);
await assert.rejects(() => shell.runCommand("bash", ["-c", "echo nope"]), /not allowed/);
await assert.rejects(() => shell.runCommand("git", ["push", "origin", "main"]), /not allowed/);
const gs = await shell.runCommand("git", ["status", "--short"]);
assert.match(gs, /exit 0/);

// exa_search: offline tests with a mocked fetch (no real API calls)
const realFetch = globalThis.fetch;
type MockFetch = (url: string, init: RequestInit) => Promise<Response>;
function mockFetch(handler: MockFetch): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => handler(url, init)) as typeof fetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function resetFetch(): void {
  globalThis.fetch = realFetch;
}

// Missing key: fails fast without any fetch call
let called = false;
mockFetch(() => { called = true; return jsonResponse({}); });
const noKey = new ExaSearchTools("");
assert.match(await noKey.search({ query: "x" }), /^error: web search not configured \(set EXO_API_KEY in \.env\)/);
assert.equal(called, false, "no fetch call without an API key");

// Argument validation errors
const exa = new ExaSearchTools("test-key");
assert.match(await exa.search({ query: "   " }), /^error: missing required argument: query/);
assert.match(await exa.search({ query: "x", category: "nope" }), /^error: invalid category "nope"/);
assert.match(await exa.search({ query: "x", type: "warp" }), /^error: invalid type "warp"/);

// Happy path: request shape + pretty-printed JSON response
let lastInit: RequestInit | undefined;
mockFetch(async (url, init) => {
  lastInit = init;
  return jsonResponse({
    requestId: "abc",
    results: [
      {
        title: "Example Page",
        url: "https://example.com/page",
        publishedDate: "2026-07-02",
        highlights: ["relevant excerpt"],
        text: "full page text here",
      },
      { title: "No Date", url: "https://example.com/2", publishedDate: null, highlights: [], text: null },
    ],
  });
});
const searchOut = await exa.search({ query: "latest news", numResults: 7, type: "deep" });
const body = JSON.parse(lastInit!.body as string) as Record<string, unknown>;
assert.equal(lastInit!.method, "POST");
assert.equal((lastInit!.headers as Record<string, string>).Authorization, "Bearer test-key");
assert.equal(body.query, "latest news");
assert.equal(body.type, "deep");
assert.equal(body.numResults, 7);
assert.equal(body.contents.highlights, true);
assert.equal((body.contents as { text: { maxCharacters: number } }).text.maxCharacters, 8000);
assert.equal("useAutoprompt" in body, false, "deprecated params must not be sent");

const parsed = JSON.parse(searchOut) as {
  query: string;
  count: number;
  results: Array<{ title: string; url: string; publishedDate: string | null; highlights: string[]; text: string | null }>;
};
assert.equal(parsed.query, "latest news");
assert.equal(parsed.count, 2);
assert.deepEqual(Object.keys(parsed.results[0]).sort(), ["highlights", "publishedDate", "text", "title", "url"]);
assert.equal(parsed.results[0].title, "Example Page");
assert.deepEqual(parsed.results[0].highlights, ["relevant excerpt"]);
assert.equal(parsed.results[1].text, null);

// Options are forwarded (category, includeDomains, date filters)
mockFetch(async (_url, init) => {
  lastInit = init;
  return jsonResponse({ results: [] });
});
await exa.search({
  query: "q",
  category: "news",
  includeDomains: ["reuters.com"],
  startPublishedDate: "2026-01-01",
  endPublishedDate: "2026-02-01",
});
const body2 = JSON.parse(lastInit!.body as string) as Record<string, unknown>;
assert.equal(body2.category, "news");
assert.deepEqual(body2.includeDomains, ["reuters.com"]);
assert.equal(body2.startPublishedDate, "2026-01-01");
assert.equal(body2.endPublishedDate, "2026-02-01");

// HTTP error surface as "error:" strings
mockFetch(async () => jsonResponse({ error: "rate limited" }, 429));
assert.match(await exa.search({ query: "x" }), /^error: exa API HTTP 429/);

// Network failure / timeout surface as "error:" strings
mockFetch(async () => {
  throw new DOMException("aborted", "AbortError");
});
assert.match(await exa.search({ query: "x" }), /^error: exa API timed out after 30s/);

resetFetch();

await fs.rm(ws, { recursive: true, force: true });
console.log("smoke: all checks passed");
