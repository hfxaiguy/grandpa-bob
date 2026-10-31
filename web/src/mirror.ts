/**
 * Desktop mirror: a folder on the machine running the storage bridge kept in
 * sync with this tab's OPFS workspace.
 *
 * OPFS stays canonical — the agent, SQLite and git all keep working on it.
 * The mirror gives the workspace a real path on the desktop (so desktop-only
 * operations can run against it) and receives workspace copies from other
 * machines through the same bridge. Policy on divergent files: the tab's
 * bytes win; the desktop variant is preserved next to it as a `.conflict-*`
 * copy by the bridge.
 *
 * Only the host-lease primary tab mirrors, so two tabs never fight over one
 * folder.
 */
import { buildHashmap, type Hashmap } from "./sync/hashmap";
import type { Platform } from "./platform/types";
import { fromBase64 } from "./workspace-transfer";
import { STATE_HOME } from "./state-dir";

export type MirrorPhase = "unlinked" | "idle" | "syncing" | "offline" | "error";

export interface MirrorStatus {
  phase: MirrorPhase;
  detail: string;
  folder: string;
  lastSyncAt: string | null;
}

export interface DesktopMirror {
  start(): void;
  stop(): void;
  /** Run one sync now (the profile dialog's "Sync now"). */
  syncNow(): Promise<MirrorStatus>;
  status(): MirrorStatus;
  onStatus(cb: (status: MirrorStatus) => void): () => void;
}

export interface DesktopMirrorOptions {
  platform: Platform;
  /** Storage bridge origin, e.g. http://127.0.0.1:8795. */
  server: string;
  /** Registered bridge root name for this profile. */
  folder: string;
  intervalMs?: number;
  /** Skip a tick while an agent turn is running. */
  isBusy?: () => boolean;
  log?: (message: string, status: MirrorStatus) => void;
}

interface PullEntry {
  path: string;
  base64: string;
  hash: string;
  bytes: number;
}

interface MirrorPlan {
  pull: PullEntry[];
  pullDeletes: string[];
  push: string[];
  pushDeletes: string[];
  conflicts: string[];
}

export const DEFAULT_MIRROR_INTERVAL_MS = 60_000;
export const MIN_MIRROR_INTERVAL_MS = 15_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createDesktopMirror(opts: DesktopMirrorOptions): DesktopMirror {
  const base = opts.server.replace(/\/+$/, "");
  const interval = Math.max(MIN_MIRROR_INTERVAL_MS, opts.intervalMs ?? DEFAULT_MIRROR_INTERVAL_MS);
  const log = opts.log ?? (() => {});
  const listeners = new Set<(status: MirrorStatus) => void>();
  let status: MirrorStatus = {
    phase: "idle",
    detail: "waiting for the first sync",
    folder: opts.folder,
    lastSyncAt: null,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  /** The in-flight pass; `syncNow` joins it instead of silently skipping. */
  let current: Promise<MirrorStatus> | null = null;

  function setStatus(patch: Partial<MirrorStatus>): void {
    status = { ...status, ...patch };
    for (const cb of listeners) cb(status);
  }

  async function call<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bob-root": opts.folder,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `storage bridge HTTP ${res.status}`);
    return json;
  }

  /** First sync for a desktop profile the bridge does not know yet: the
   *  profile was created with the default `~/.bobkat/folders/<name>` root. */
  async function requestPlan(
    manifest: Hashmap,
  ): Promise<{ plan: MirrorPlan; initial?: boolean }> {
    try {
      return await call<{ plan: MirrorPlan; initial?: boolean }>("/mirror/plan", { manifest });
    } catch (err) {
      if (!/unknown folder root/i.test(messageOf(err))) throw err;
      await call("/roots", { name: opts.folder, dir: `${STATE_HOME}/folders/${opts.folder}` });
      return await call<{ plan: MirrorPlan; initial?: boolean }>("/mirror/plan", { manifest });
    }
  }

  async function readLocalBase64(path: string): Promise<string | null> {
    const abs = opts.platform.path.join(opts.platform.workspaceRoot, path);
    const exists = await opts.platform.fs
      .stat(abs)
      .then(() => true)
      .catch(() => false);
    if (!exists) return null;
    const fs = opts.platform.fs as { readFileBytes?: (p: string) => Promise<Uint8Array> };
    const bytes =
      (await fs.readFileBytes?.(abs).catch(() => undefined)) ??
      new TextEncoder().encode(await opts.platform.fs.readFile(abs, "utf8").catch(() => ""));
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function writeLocal(path: string, base64: string): Promise<void> {
    const abs = opts.platform.path.join(opts.platform.workspaceRoot, path);
    await opts.platform.fs.mkdir(opts.platform.path.dirname(abs), { recursive: true });
    await opts.platform.fs.writeFile(abs, fromBase64(base64));
  }

  async function deleteLocal(path: string): Promise<void> {
    const abs = opts.platform.path.join(opts.platform.workspaceRoot, path);
    await opts.platform.fs.rm(abs).catch(() => undefined);
  }

  async function syncOnce(): Promise<MirrorStatus> {
    if (opts.isBusy?.()) {
      setStatus({ phase: "idle", detail: "waiting for the agent to finish" });
      return status;
    }
    setStatus({ phase: "syncing", detail: "comparing workspaces" });
    try {
      const mine = await buildHashmap(opts.platform, opts.platform.workspaceRoot);
      const { plan, initial } = await requestPlan(mine);

      // Pull first: the desktop's changes land in OPFS before the next push,
      // so the manifests this round agrees on are applied consistently.
      for (const entry of plan.pull) await writeLocal(entry.path, entry.base64);
      for (const path of plan.pullDeletes) await deleteLocal(path);

      // The manifest after applying pulls is what the bridge records as the
      // new common base once this workspace's pushes are written.
      const manifest: Hashmap = { ...mine };
      for (const entry of plan.pull) {
        manifest[entry.path] = { hash: entry.hash, bytes: entry.bytes };
      }
      for (const path of plan.pullDeletes) delete manifest[path];

      const writes: Array<{ path: string; base64: string }> = [];
      for (const path of plan.push) {
        const base64 = await readLocalBase64(path);
        if (base64 !== null) writes.push({ path, base64 });
      }

      const touched =
        plan.pull.length + plan.pullDeletes.length + writes.length + plan.pushDeletes.length;
      // `initial` persists the first common base even when both sides happen
      // to match already; after that a quiet tick writes nothing.
      if (touched || plan.conflicts.length || initial) {
        await call("/mirror/apply", {
          writes,
          deletes: plan.pushDeletes,
          conflicts: plan.conflicts,
          manifest,
        });
      }

      const at = new Date().toISOString();
      setStatus({
        phase: "idle",
        detail: plan.conflicts.length
          ? `synced · ${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? "" : "s"} kept on the desktop`
          : touched
            ? `synced ${touched} change${touched === 1 ? "" : "s"}`
            : "in sync",
        lastSyncAt: at,
      });
      log("synced", status);
      return status;
    } catch (err) {
      const text = messageOf(err);
      const offline = /Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED/i.test(text);
      setStatus({
        phase: offline ? "offline" : "error",
        detail: offline
          ? `storage bridge unreachable at ${base}`
          : `sync failed: ${text}`,
      });
      log(offline ? "offline" : "failed", status);
      return status;
    }
  }

  function tick(): Promise<MirrorStatus> {
    if (!current) {
      current = syncOnce().finally(() => {
        current = null;
      });
    }
    return current;
  }

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), interval);
      // A page in the background should not hold a process/timer open.
      const t = timer as unknown as { unref?: () => void };
      t.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    syncNow: () => tick(),
    status: () => status,
    onStatus(cb) {
      listeners.add(cb);
      cb(status);
      return () => listeners.delete(cb);
    },
  };
}
