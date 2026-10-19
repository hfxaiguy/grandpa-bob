/**
 * "Desktop (direct)" platform: the browser operates on a real folder on the
 * hard drive with the File System Access API — no server process, no import
 * into OPFS. The user picks the workspace once; the handle is persisted in
 * IndexedDB and re-granted with one click after a reload (browser policy).
 *
 * Supported in Chromium-based browsers. Firefox/Safari keep using the
 * "Desktop (local server)" bridge, which implements the same Platform
 * interface over a loopback HTTP bridge.
 */
import { posixPath } from "../../../src/platform/paths";
import { sha256hex } from "../../../src/platform/sha256";
import { createCoreutilsShell } from "../../../src/platform/coreutils";
import type { CryptoOps, Platform } from "../../../src/platform/types";
import { createHandleFs } from "./handle-fs";
import { createHandleGit } from "./git-handle";
import { createSqliteWasm } from "./sqlite-wasm";

const DB_NAME = "bob-fsaccess";
const STORE = "handles";
const KEY = "workspace";

export type FsAccessPermission = "granted" | "prompt" | "denied";

/** True when the runtime exposes the File System Access API. */
export function supportsFsAccess(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      "function"
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB unavailable"));
  });
}

/** Persist the picked folder so the next visit only needs a permission grant. */
export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("could not store directory handle"));
    tx.onabort = () => reject(tx.error ?? new Error("could not store directory handle"));
  });
  db.close();
}

export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error("could not read directory handle"));
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

export async function clearDirectoryHandle(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    db.close();
  } catch {
    /* nothing to clear */
  }
}

interface PermissionCapableHandle extends FileSystemDirectoryHandle {
  queryPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}

/** Current permission for the stored folder (does not prompt). */
export async function directoryPermission(
  handle: FileSystemDirectoryHandle,
): Promise<FsAccessPermission> {
  const h = handle as PermissionCapableHandle;
  if (!h.queryPermission) return "granted"; // older implementations: assume granted
  try {
    const state = await h.queryPermission({ mode: "readwrite" });
    return state as FsAccessPermission;
  } catch {
    return "prompt";
  }
}

/**
 * Ask the browser to (re-)grant read/write access. Must run inside a user
 * gesture — call it directly from a click handler.
 */
export async function requestDirectoryPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const h = handle as PermissionCapableHandle;
  const current = await directoryPermission(handle);
  if (current === "granted") return true;
  if (!h.requestPermission) return true;
  try {
    return (await h.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/** Show the folder picker and remember the choice. */
export async function pickWorkspaceDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (opts?: {
        id?: string;
        mode?: "read" | "readwrite";
        startIn?: string;
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) {
    throw new Error("This browser does not support direct folder access (use the local server bridge)");
  }
  const handle = await picker({ id: "bob-workspace", mode: "readwrite", startIn: "documents" });
  await requestDirectoryPermission(handle);
  await saveDirectoryHandle(handle);
  return handle;
}

/**
 * Build a platform that reads and writes the picked folder in place.
 * The root maps to "/", so workspace paths look exactly like the other targets.
 */
export function createFsAccessPlatform(rootHandle: FileSystemDirectoryHandle): Platform {
  const fs = createHandleFs(async () => rootHandle);
  const workspaceRoot = "/";
  const crypto: CryptoOps = { randomUUID: () => crypto.randomUUID(), sha256hex };
  return {
    kind: "browser",
    path: posixPath,
    fs,
    crypto,
    shell: createCoreutilsShell({ fs, path: posixPath, workspaceRoot }),
    git: createHandleGit(fs, workspaceRoot),
    // The worker was initialized with the picked handle by the caller; see
    // initSqlite(rootHandle) in initSqlite.ts / main.ts / agent-worker.ts.
    sqlite: createSqliteWasm(),
    workspaceRoot,
  };
}
