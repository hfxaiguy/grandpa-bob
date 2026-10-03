/**
 * Browser target entry point.
 *
 * The page is a chat UI driven by the agent worker. The same demos from the
 * milestones also run at startup to keep the OPFS / SQLite / LLM / loader paths
 * exercised end-to-end; their output goes to the diagnostics panel (and is what
 * `npm run smoke` checks).
 */
import "./shims/process";
import { setActiveFs } from "./shims/node-fs-promises";
import { createBrowserPlatform, initSqlite } from "./platform/browser";
import { createDesktopPlatform } from "./platform/desktop";
import { AgentClient } from "./agent/agent-client";
import {
  loadEnv,
  loadRemote,
  loadStorage,
  loadStorageServer,
  saveStorage,
  saveStorageServer,
  setEnvVar,
  type StorageMode,
} from "./settings";
import { exportWorkspace, importWorkspace } from "./workspace-transfer";
import { cloneWorkspace } from "./platform/git-opfs";
import { FileTools } from "../../src/tools/files";
import type { Platform } from "../../src/platform/types";
import { Tree, name, Prompt, knit } from "grandma-kat";
import { listTreeSources } from "../../src/tree-sources";
import { promoteTree, snapshotTree } from "../../src/tree-versions";

const out = document.getElementById("out")!;
const lines: string[] = [];
const log = (line: string) => {
  lines.push(line);
  out.textContent = lines.join("\n");
};

// ── chat UI ──────────────────────────────────────────────────────────────
const chatLog = document.getElementById("chat-log")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const chatSend = document.getElementById("chat-send") as HTMLButtonElement;
const agent = new AgentClient();
let agentReady = false;
/** Git remote configured for this session (settings or ?remote=). */
let configuredRemote = "";
/** Storage backend: browser OPFS, or the desktop via the local bridge. */
const params = new URLSearchParams(location.search);
const storageMode: StorageMode = (params.get("storage") as StorageMode) ?? loadStorage();
const storageServer = params.get("server") ?? loadStorageServer();
configuredRemote = params.get("remote") ?? loadRemote();
const runOptions = (pattern: string, task = "") => ({
  task,
  env: loadEnv(),
  pattern,
  remote: configuredRemote,
  storage: storageMode,
  server: storageServer,
});

// ── storage selector ─────────────────────────────────────────────────────
const storageSelect = document.getElementById("storage-mode") as HTMLSelectElement | null;
const storageServerInput = document.getElementById("storage-server") as HTMLInputElement | null;
if (storageSelect) storageSelect.value = storageMode;
if (storageServerInput) storageServerInput.value = storageServer;
const applyStorage = (): void => {
  if (storageSelect) saveStorage(storageSelect.value as StorageMode);
  if (storageServerInput) saveStorageServer(storageServerInput.value.trim());
  location.reload();
};
storageSelect?.addEventListener("change", applyStorage);
storageServerInput?.addEventListener("change", applyStorage);

function appendMessage(role: "user" | "assistant", text: string): void {
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function answerText(result: unknown): string {
  if (result && typeof result === "object" && "answer" in result) {
    return String((result as { answer: unknown }).answer);
  }
  return JSON.stringify(result);
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !agentReady) return;
  appendMessage("user", text);
  chatInput.value = "";
  chatSend.disabled = true;
  void agent
    .run(runOptions("patterns/sync.mjs", text))
    .then(({ result }) => appendMessage("assistant", answerText(result)))
    .catch((err: unknown) => appendMessage("assistant", `error: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => {
      chatSend.disabled = false;
      chatInput.focus();
    });
});

// ── startup checks/demos ─────────────────────────────────────────────────
async function opfsSmoke(root: string): Promise<void> {
  const platform = createBrowserPlatform(root);
  const { fs, path } = platform;

  log(`platform: ${platform.kind}   workspace: ${platform.workspaceRoot}`);
  if (!navigator.storage?.getDirectory) {
    log("OPFS is not available in this browser.");
    return;
  }

  const dir = path.join(root, "notes");
  const file = path.join(dir, "hello.txt");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, "hello from the browser workspace\n");
  const text = await fs.readFile(file);
  log(`fs: wrote/read ${path.relative(root, file)} -> ${JSON.stringify(text.trim())}`);

  await fs.rename(file, path.join(dir, "renamed.txt"));
  const entries = await fs.readdir(dir, { withFileTypes: true });
  log(`fs: notes/ = ${entries.map((e) => e.name).join(", ")}`);
  log(`crypto: sha256("abc") = ${platform.crypto.sha256hex("abc")}`);
}

async function sharedTreesDemo(root: string): Promise<void> {
  const platform = createBrowserPlatform(root);
  const { fs, path } = platform;
  const patterns = path.join(root, "patterns");
  await fs.mkdir(patterns, { recursive: true });
  await fs.writeFile(
    path.join(patterns, "hello.mjs"),
    "// hello.mjs — a demo tree\nexport default 1;\n",
  );
  await fs.writeFile(path.join(patterns, "hello.spec.md"), "# hello\n\nDemo spec.\n");

  log("shared: listTreeSources()");
  const before = (await listTreeSources(root)).filter((s) => s.name === "hello");
  log(`  ${JSON.stringify(before[0] ?? null)}`);

  const snap = await snapshotTree(root, "hello");
  log(`shared: snapshotTree -> ${JSON.stringify(snap)}`);

  const promoted = await promoteTree(root, "hello", snap.version);
  log(`shared: promoteTree -> ${JSON.stringify(promoted)}`);

  const after = (await listTreeSources(root)).filter((s) => s.name === "hello")[0];
  log(`shared: after promote -> prod=${after?.prod} versions=[${after?.versions.join(",")}]`);
}

async function grandmaKatDemo(root: string): Promise<void> {
  const pattern = Tree(
    name("browser_demo"),
    Prompt((m: { task?: string }) => `task: ${m.task}`),
  );
  const runtime = {
    models: {
      default: {
        model: "mock",
        handler: async (messages: unknown[]) => ({
          content: `hello from grandma-kat (${messages.length} message(s))`,
        }),
      },
    },
    tools: {},
    memory: { task: "say hi" },
    logger: false,
  };
  const { result } = await knit(pattern, runtime);
  log(`grandma-kat: knit -> ${JSON.stringify(result)}`);
}

async function sqliteDemo(root: string): Promise<void> {
  await initSqlite();
  const { sqlite } = createBrowserPlatform(root);
  const file = `${root}/demo.db`;

  const db = await sqlite.open(file, { readOnly: false });
  await db.exec("DROP TABLE IF EXISTS people");
  await db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)");
  await (await db.prepare("INSERT INTO people (name) VALUES (?)")).run("Ada");
  const inserted = await (await db.prepare("INSERT INTO people (name) VALUES (?)")).run("Grace");
  const rows = await (await db.prepare("SELECT id, name FROM people ORDER BY id")).all();
  await db.close();
  log(`sqlite: inserted changes=${String(inserted.changes)} -> ${JSON.stringify(rows)}`);

  const reopened = await sqlite.open(file, { readOnly: true });
  const count = (await (await reopened.prepare("SELECT COUNT(*) AS n FROM people")).get()) as { n: number };
  await reopened.close();
  log(`sqlite: persisted rows after reopen = ${count.n}`);
}

/** Write the demo pattern + model registry into the active workspace. */
async function bootstrapWorkspace(platform: Platform, root: string): Promise<void> {
  const { fs, path } = platform;
  await fs.mkdir(path.join(root, "patterns"), { recursive: true });
  await fs.writeFile(
    path.join(root, "patterns", "agent_demo.mjs"),
    [
      'import { Tree, name, Prompt, Call, Tools, Return } from "grandma-kat";',
      "",
      "const pattern = Tree(",
      '  name("agent_demo"),',
      '  Tools("read_file"),',
      '  Prompt("answer", (m) => `read ${m.task}`),',
      '  Call("file", "read_file", { path: "notes/renamed.txt" }),',
      "  Return((m) => ({ answer: m.branch.answer, file: m.branch.file })),",
      ");",
      "",
      "export default pattern;",
      "",
    ].join("\n"),
  );

  setEnvVar("DEMO_API_KEY", "test-key");
  await fs.writeFile(
    path.join(root, "models.json"),
    JSON.stringify({
      default: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "${DEMO_API_KEY}", model: "mock-model" },
    }),
  );

  // A multi-file pattern: imports a named export from a relative submodule,
  // which itself uses a node: shim — the shape app trees use.
  await fs.mkdir(path.join(root, "patterns", "lib"), { recursive: true });
  await fs.writeFile(
    path.join(root, "patterns", "lib", "helper.mjs"),
    ['import path from "node:path";', 'export function describe(name) { return path.join("read", name); }', ""].join(
      "\n",
    ),
  );
  await fs.writeFile(
    path.join(root, "patterns", "multi.mjs"),
    [
      'import { Tree, name, Prompt, Call, Tools, Return } from "grandma-kat";',
      'import { describe } from "./lib/helper.mjs";',
      "",
      "const pattern = Tree(",
      '  name("multi_demo"),',
      '  Tools("read_file"),',
      '  Prompt("answer", (m) => describe(String(m.task))),',
      '  Call("file", "read_file", { path: "notes/renamed.txt" }),',
      "  Return((m) => ({ answer: m.branch.answer, file: m.branch.file })),",
      ");",
      "",
      "export default pattern;",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "patterns", "git_demo.mjs"),
    [
      'import { Tree, name, Call, Tools, Return } from "grandma-kat";',
      "",
      "const pattern = Tree(",
      '  name("git_demo"),',
      '  Tools("git_status", "git_log"),',
      '  Call("status", "git_status", {}),',
      '  Call("log", "git_log", {}),',
      "  Return((m) => ({ status: m.branch.status, log: m.branch.log })),",
      ");",
      "",
      "export default pattern;",
      "",
    ].join("\n"),
  );

  // The chat/assistant pattern: exposes the git tools so a request like
  // "sync workspace git to main" can be handled by committing then pushing.
  await fs.writeFile(
    path.join(root, "patterns", "sync.mjs"),
    [
      'import { Tree, name, Model, Tools, Prompt, Return } from "grandma-kat";',
      "",
      "const pattern = Tree(",
      '  name("sync"),',
      '  Model("default"),',
      '  Tools("git_status", "git_commit", "git_push", "read_file", "write_file", "list_files"),',
      "  Prompt(",
      '    "reply",',
      '    (m) => "You are BOB. Request: " + m.task +',
      '      ". To sync the workspace git, call git_status, then git_commit, then git_push with branch main, then answer briefly."',
      "  ),",
      "  Return((m) => ({ answer: m.branch.reply })),",
      ");",
      "",
      "export default pattern;",
      "",
    ].join("\n"),
  );
}

async function agentDemo(root: string): Promise<void> {
  const platform =
    storageMode === "desktop" ? createDesktopPlatform("/", storageServer) : createBrowserPlatform(root);
  await bootstrapWorkspace(platform, platform.workspaceRoot);
  const { result, events } = await agent.run(runOptions("patterns/multi.mjs", "the notes file"));
  log(`agent-worker: storage=${storageMode} events=${events.length}`);
  log(`agent-worker: result=${JSON.stringify(result)}`);
  const answer = (result as { answer?: unknown })?.answer;
  if (typeof answer !== "string" || !answer.startsWith("llm-says")) {
    throw new Error(`expected a live-LLM answer, got ${JSON.stringify(answer)}`);
  }
  log("agent-worker: live LLM round-trip OK");
  agentReady = true;
  chatInput.disabled = false;
  chatSend.disabled = false;
  chatInput.focus();
}

async function durabilityDemo(): Promise<void> {
  const persisted = (await navigator.storage.persist?.().catch(() => false)) ?? "n/a";
  const estimate = await navigator.storage.estimate?.().catch(() => null);
  const blob = await exportWorkspace();
  const archive = JSON.parse(await blob.text()) as Parameters<typeof importWorkspace>[0];
  const restored = await importWorkspace(archive);
  log(
    `durability: persisted=${persisted} usage=${estimate?.usage ?? "?"}B backup=${blob.size}B files=${archive.files.length} restored=${restored}`,
  );
}

async function gitDemo(root: string): Promise<void> {
  const platform = createBrowserPlatform(root);
  const files = new FileTools(platform);
  await platform.git.ensureRepo();
  const result = await files.writeFile("git-demo.txt", `hello ${Date.now()}\n`);
  const match = result.match(/commit: ([0-9a-f]{7})/);
  log(`git: ${match ? `auto-commit ${match[1]}` : `WARN ${result}`}`);
}

/**
 * Prepare the OPFS workspace: clone from a configured git remote, or fall back
 * to the bundled seed archive. `?remote=<url>` overrides settings; `?reclone=1`
 * clears the workspace and clones fresh.
 */
async function prepareWorkspace(root: string): Promise<void> {
  const platform = createBrowserPlatform(root);
  const { fs, path } = platform;
  const params = new URLSearchParams(location.search);
  const remote = params.get("remote") ?? loadRemote();
  configuredRemote = remote;
  const isDir = (p: string): Promise<boolean> => fs.stat(p).then(() => true).catch(() => false);

  if (storageMode === "desktop") {
    try {
      const health = await fetch(`${storageServer}/health`).then((r) => r.json());
      log(`storage: desktop via ${storageServer} (root: ${health.root})`);
    } catch (err) {
      log(`storage: desktop bridge unreachable at ${storageServer}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (!remote) {
    await seedWorkspace(root);
    return;
  }

  const isRepo = await isDir(path.join(root, ".git"));
  if (isRepo && !params.has("reclone")) {
    const sources = await listTreeSources(root);
    log(`clone: up to date; ${sources.length} trees (trunk: ${sources.some((s) => s.name === "trunk")})`);
    return;
  }

  try {
    if (await isDir(root)) await fs.rm(root);
    await cloneWorkspace(root, remote);
    const sources = await listTreeSources(root);
    log(`clone: ${remote} -> ${sources.length} trees (trunk: ${sources.some((s) => s.name === "trunk")})`);
  } catch (err) {
    log(`clone: failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function seedWorkspace(root: string): Promise<void> {
  const platform = createBrowserPlatform(root);
  const { fs, path } = platform;
  const marker = path.join(root, ".seeded");
  const trunk = path.join(root, "patterns", "trunk.mjs");
  const isFile = (p: string): Promise<boolean> => fs.stat(p).then(() => true).catch(() => false);
  const force = new URLSearchParams(location.search).has("reseed");
  const summarize = async (prefix: string): Promise<void> => {
    const sources = await listTreeSources(root);
    log(`${prefix}; ${sources.length} trees (trunk: ${sources.some((s) => s.name === "trunk")})`);
  };
  if (!force && (await isFile(marker)) && (await isFile(trunk))) {
    await summarize("seed: ready");
    return;
  }
  try {
    const res = await fetch("/seed/workspace.json");
    if (!res.ok) {
      log("seed: no seed archive served (run `npm run make-seed`)");
      return;
    }
    const archive = (await res.json()) as Parameters<typeof importWorkspace>[0];
    const imported = await importWorkspace(archive);
    await fs.writeFile(marker, new Date().toISOString());
    await summarize(`seed: imported ${imported} files`);
  } catch (err) {
    log(`seed: failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function desktopSqlDemo(platform: Platform): Promise<void> {
  const db = await platform.sqlite.open("/sync-demo.db", { readOnly: false });
  await db.exec("DROP TABLE IF EXISTS t");
  await db.exec("CREATE TABLE t(a INTEGER)");
  await (await db.prepare("INSERT INTO t VALUES (1)")).run();
  await (await db.prepare("INSERT INTO t VALUES (2)")).run();
  const rows = await (await db.prepare("SELECT a FROM t ORDER BY a")).all();
  await db.close();
  log(`desktop-sql: rows=${JSON.stringify(rows)}`);
}

async function desktopSyncDemo(platform: Platform): Promise<void> {
  if (!configuredRemote) {
    log("desktop-git: no remote configured (pass ?remote=<path-or-url> or set bob:remote)");
    return;
  }
  await platform.git.ensureRepo();
  const files = new FileTools(platform);
  await files.writeFile("sync-demo.txt", `sync ${Date.now()}\n`);
  const pushed = await platform.git.push?.(configuredRemote, "main");
  log(`desktop-git: push main -> ${JSON.stringify(pushed)}`);
}

/** Desktop storage mode: BOB operates on the real workspace via the bridge. */
async function runDesktopMode(): Promise<void> {
  const platform = createDesktopPlatform("/", storageServer);
  setActiveFs(platform.fs);
  const health = await fetch(`${storageServer}/health`).then((r) => r.json());
  log(`storage: desktop via ${storageServer} (root: ${health.root})`);

  const sources = await listTreeSources("/");
  log(`discovery: ${sources.length} trees (trunk: ${sources.some((s) => s.name === "trunk")})`);

  await bootstrapWorkspace(platform, platform.workspaceRoot);
  const { result, events } = await agent.run(runOptions("patterns/multi.mjs", "the notes file"));
  log(`agent-worker: storage=desktop events=${events.length}`);
  log(`agent-worker: result=${JSON.stringify(result)}`);
  const answer = (result as { answer?: unknown })?.answer;
  if (typeof answer !== "string" || !answer.startsWith("llm-says")) {
    throw new Error(`expected a live-LLM answer, got ${JSON.stringify(answer)}`);
  }
  log("agent-worker: live LLM round-trip OK");

  await desktopSqlDemo(platform);
  await desktopSyncDemo(platform);

  agentReady = true;
  chatInput.disabled = false;
  chatSend.disabled = false;
  chatInput.focus();
}

async function main(): Promise<void> {
  const root = "/workspace";
  if (storageMode === "desktop") {
    await runDesktopMode();
    log("");
    log("SMOKE_DONE");
    log("OK");
    return;
  }

  await prepareWorkspace(root);
  log("");
  await opfsSmoke(root);
  log("");
  await sharedTreesDemo(root);
  log("");
  await grandmaKatDemo(root);
  log("");
  await sqliteDemo(root);
  log("");
  await agentDemo(root);
  log("");
  await gitDemo(root);
  log("");
  const gitTools = await agent.run(runOptions("patterns/git_demo.mjs"));
  const gitResult = gitTools.result as {
    status?: { branch?: string; changes?: unknown[] };
    log?: { commits?: unknown[] };
  };
  log(
    `git-tools: branch=${gitResult?.status?.branch ?? "?"} changes=${gitResult?.status?.changes?.length ?? "?"} commits=${gitResult?.log?.commits?.length ?? "?"}`,
  );
  log("");
  await durabilityDemo();
  log("");
  log("SMOKE_DONE");
  log("OK");
}

main().catch((err) => {
  log(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
