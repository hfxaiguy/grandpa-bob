/**
 * Browser target entry point.
 *
 * Renders the *exact* Node admin pages (src/ui/pages.ts) inside an iframe and
 * serves their /api/* calls from an in-browser backend (AgentClient + Platform)
 * via a fetch/EventSource shim. A thin toolbar above the iframe selects the
 * storage backend; everything else — including git sync — is the shared UI.
 */
import "./shims/process";
import { setActiveFs, setFsIndex } from "./shims/node-fs-promises";
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
  loadModelsJson,
  saveStorage,
  saveStorageServer,
  type StorageMode,
} from "./settings";
import { importWorkspace } from "./workspace-transfer";
import { cloneWorkspace } from "./platform/git-opfs";
import { applyDatabaseDumps } from "../../src/db-sync";
import { createAutoSync, DEFAULT_INTERVAL_MS } from "../../src/auto-sync";
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
if (storageSelect) storageSelect.value = storageMode;
if (storageServerInput) storageServerInput.value = storageServer;

const applyStorage = (): void => {
  if (storageSelect) saveStorage(storageSelect.value as StorageMode);
  if (storageServerInput) saveStorageServer(storageServerInput.value.trim());
  location.reload();
};
storageSelect?.addEventListener("change", applyStorage);
storageServerInput?.addEventListener("change", applyStorage);

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
    await applyDatabaseDumps(platform, { onlyMissing: true }).catch(() => {});
    setStatus("workspace ready");
    return;
  }
  setStatus("seeding workspace…");
  await seedWorkspace("/workspace", platform);
  await applyDatabaseDumps(platform, { onlyMissing: true }).catch(() => {});
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

/** Load the sync fs index so tree patterns' `appTreeNames()` works on this thread. */
async function buildFsIndex(platform: Platform): Promise<void> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await platform.fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = platform.path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(platform.workspaceRoot);
  setFsIndex(files);
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

// ── boot ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await initSqlite().catch(() => {});
  await prepareWorkspace();

  const platform = activePlatform();
  setActiveFs(platform.fs);
  await buildFsIndex(platform);
  await ensureModels(platform);

  // Periodic two-way git sync (pull then push) when a remote is configured.
  if (storageMode !== "desktop" && configuredRemote) {
    const intervalMs = Number(localStorage.getItem("autoSyncIntervalMs") ?? "") || DEFAULT_INTERVAL_MS;
    createAutoSync({
      platform,
      remote: () => configuredRemote,
      intervalMs,
      log: (m, r) => console.log(`[auto-sync] ${m}${r?.error ? `: ${r.error}` : ""}`),
    }).start();
  }

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
