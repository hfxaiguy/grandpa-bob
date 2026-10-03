/**
 * Browser target entry point.
 *
 * Renders the *exact* Node admin pages (src/ui/pages.ts) inside an iframe and
 * serves their /api/* calls from an in-browser backend (AgentClient + Platform)
 * via a fetch/EventSource shim. A thin toolbar above the iframe selects the
 * storage backend and drives git sync; everything else is the shared UI.
 */
import "./shims/process";
import { setActiveFs } from "./shims/node-fs-promises";
import { createBrowserPlatform, initSqlite } from "./platform/browser";
import { createDesktopPlatform } from "./platform/desktop";
import { AgentClient } from "./agent/agent-client";
import { createLocalBackend } from "./server/local-backend";
import { hostUi } from "./ui-host";
import {
  loadEnv,
  loadRemote,
  loadStorage,
  loadStorageServer,
  loadBranch,
  loadModelsJson,
  saveStorage,
  saveStorageServer,
  saveRemote,
  saveBranch,
  type StorageMode,
} from "./settings";
import { importWorkspace } from "./workspace-transfer";
import { cloneWorkspace } from "./platform/git-opfs";
import { listTreeSources } from "../../src/tree-sources";
import type { Platform } from "../../src/platform/types";

const params = new URLSearchParams(location.search);
const storageMode: StorageMode = (params.get("storage") as StorageMode) ?? loadStorage();
const storageServer = params.get("server") ?? loadStorageServer();
let configuredRemote = params.get("remote") ?? loadRemote();

const statusEl = document.getElementById("status")!;
const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

// ── toolbar ──────────────────────────────────────────────────────────────
const storageSelect = document.getElementById("storage-mode") as HTMLSelectElement | null;
const storageServerInput = document.getElementById("storage-server") as HTMLInputElement | null;
const gitRemoteInput = document.getElementById("git-remote") as HTMLInputElement | null;
const gitBranchInput = document.getElementById("git-branch") as HTMLInputElement | null;
const gitSyncBtn = document.getElementById("git-sync") as HTMLButtonElement | null;
if (storageSelect) storageSelect.value = storageMode;
if (storageServerInput) storageServerInput.value = storageServer;
if (gitRemoteInput) gitRemoteInput.value = configuredRemote;
if (gitBranchInput) gitBranchInput.value = loadBranch();
if (params.get("gitremote") && gitRemoteInput) {
  gitRemoteInput.value = params.get("gitremote")!;
  configuredRemote = gitRemoteInput.value;
}
if (params.get("gitbranch") && gitBranchInput) gitBranchInput.value = params.get("gitbranch")!;

const applyStorage = (): void => {
  if (storageSelect) saveStorage(storageSelect.value as StorageMode);
  if (storageServerInput) saveStorageServer(storageServerInput.value.trim());
  location.reload();
};
storageSelect?.addEventListener("change", applyStorage);
storageServerInput?.addEventListener("change", applyStorage);
gitRemoteInput?.addEventListener("change", () => {
  configuredRemote = gitRemoteInput.value.trim();
  saveRemote(configuredRemote);
});
gitBranchInput?.addEventListener("change", () => saveBranch(gitBranchInput.value.trim() || "main"));

function activePlatform(): Platform {
  return storageMode === "desktop"
    ? createDesktopPlatform("/", storageServer)
    : createBrowserPlatform("/workspace");
}

// ── workspace preparation (browser mode) ─────────────────────────────────
async function isFile(p: string): Promise<boolean> {
  return activePlatform().fs.stat(p).then(() => true).catch(() => false);
}

async function seedWorkspace(root: string, platform: Platform): Promise<void> {
  const marker = platform.path.join(root, ".seeded");
  const trunk = platform.path.join(root, "patterns", "trunk.mjs");
  const force = params.has("reseed");
  if (!force && (await isFile(marker)) && (await isFile(trunk))) return;
  try {
    const res = await fetch("/seed/workspace.json");
    if (!res.ok) return;
    const archive = (await res.json()) as Parameters<typeof importWorkspace>[0];
    await importWorkspace(archive);
    await platform.fs.writeFile(marker, new Date().toISOString());
  } catch {
    /* seed is optional */
  }
}

async function prepareWorkspace(): Promise<void> {
  if (storageMode === "desktop") {
    try {
      const health = await fetch(`${storageServer}/health`).then((r) => r.json());
      setStatus(`desktop: ${health.root}`);
    } catch {
      setStatus(`desktop bridge unreachable at ${storageServer}`);
    }
    return;
  }
  const platform = createBrowserPlatform("/workspace");
  if (configuredRemote) {
    const gitDir = platform.path.join("/workspace", ".git");
    const hasRepo = await isFile(gitDir);
    if (!hasRepo || params.has("reclone")) {
      setStatus(`cloning ${configuredRemote}…`);
      if (await isFile("/workspace")) await platform.fs.rm("/workspace");
      await cloneWorkspace("/workspace", configuredRemote);
    }
    setStatus("workspace ready");
    return;
  }
  setStatus("seeding workspace…");
  await seedWorkspace("/workspace", platform);
  setStatus("workspace ready");
}

/** Make sure models.json exists (a mock entry) so the agent can run. */
async function ensureModels(platform: Platform): Promise<void> {
  const file = platform.path.join(platform.workspaceRoot, "models.json");
  if (await isFile(file)) return;
  await platform.fs.writeFile(
    file,
    JSON.stringify({
      default: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
      strong: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
      cheap: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test-key", model: "mock-model" },
    }),
  );
}

async function detectPattern(platform: Platform): Promise<string> {
  try {
    const sources = await listTreeSources(platform.workspaceRoot);
    if (sources.some((s) => s.name === "trunk")) return "patterns/trunk.mjs";
    if (sources[0]) return `patterns/${sources[0].name}.mjs`;
  } catch {
    /* fall through */
  }
  return "patterns/trunk.mjs";
}

async function syncWorkspace(platform: Platform): Promise<void> {
  const remote = (gitRemoteInput?.value ?? configuredRemote).trim();
  const branch = (gitBranchInput?.value ?? "main").trim() || "main";
  if (!remote) {
    setStatus("set a git remote first");
    return;
  }
  if (gitSyncBtn) gitSyncBtn.disabled = true;
  try {
    await platform.git.ensureRepo();
    const commit = platform.git.commitAll
      ? await platform.git.commitAll(`sync from BOB ${new Date().toISOString()}`)
      : await platform.git.autoCommit(["."], "sync from BOB");
    const pushed = platform.git.push ? await platform.git.push(remote, branch) : { error: "push unavailable" };
    setStatus(`committed ${commit}; pushed ${branch}`);
    void pushed;
  } catch (err) {
    setStatus(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (gitSyncBtn) gitSyncBtn.disabled = false;
  }
}
gitSyncBtn?.addEventListener("click", () => void syncWorkspace(activePlatform()));

// ── boot ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await initSqlite().catch(() => {});
  await prepareWorkspace();

  const platform = activePlatform();
  setActiveFs(platform.fs);
  await ensureModels(platform);

  const pattern = await detectPattern(platform);
  const agent = new AgentClient();
  const backend = createLocalBackend({
    agent,
    platform,
    storage: storageMode,
    server: storageServer,
    env: loadEnv(),
    remote: configuredRemote,
    initialPattern: pattern,
    modelsJson: loadModelsJson(),
  });

  hostUi(backend, document.getElementById("app")!, { page: "chat", port: 8080 });
  setStatus(`${storageMode} · ${pattern.replace("patterns/", "")}`);
}

main().catch((err) => {
  setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
});
