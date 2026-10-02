/**
 * Browser target entry point.
 *
 * The page is a chat UI driven by the agent worker. The same demos from the
 * milestones also run at startup to keep the OPFS / SQLite / LLM / loader paths
 * exercised end-to-end; their output goes to the diagnostics panel (and is what
 * `npm run smoke` checks).
 */
import "./shims/process";
import { createBrowserPlatform, initSqlite } from "./platform/browser";
import { AgentClient } from "./agent/agent-client";
import { loadEnv, setEnvVar } from "./settings";
import { exportWorkspace, importWorkspace } from "./workspace-transfer";
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
    .run(text, loadEnv())
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

/** Write the demo pattern + model registry into the OPFS workspace. */
async function bootstrapWorkspace(root: string): Promise<void> {
  const { fs, path } = createBrowserPlatform(root);
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
}

async function agentDemo(root: string): Promise<void> {
  await bootstrapWorkspace(root);
  const { result, events } = await agent.run("the notes file", loadEnv());
  log(`agent-worker: events=${events.length}`);
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

async function main(): Promise<void> {
  const root = "/workspace";
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
  await durabilityDemo();
  log("");
  log("OK");
}

main().catch((err) => {
  log(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
