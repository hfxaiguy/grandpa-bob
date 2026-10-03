/**
 * Browser settings: environment values used for models.json `${ENV}` key
 * interpolation. Stored in localStorage (a personal-app key store); never sent
 * anywhere except the configured LLM endpoint.
 */
const KEY = "bob:env";

export function loadEnv(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveEnv(env: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(env));
  } catch {
    // storage unavailable (private mode); keys just won't persist
  }
}

export function setEnvVar(name: string, value: string): void {
  saveEnv({ ...loadEnv(), [name]: value });
}

const REMOTE_KEY = "bob:remote";
const STORAGE_KEY = "bob:storage";
const SERVER_KEY = "bob:storage-server";

/** Workspace git remote to clone from on startup. */
export function loadRemote(): string {
  try {
    return localStorage.getItem(REMOTE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveRemote(url: string): void {
  try {
    if (url) localStorage.setItem(REMOTE_KEY, url);
    else localStorage.removeItem(REMOTE_KEY);
  } catch {
    // ignore
  }
}

const BRANCH_KEY = "bob:branch";

/** Branch to push to when syncing. */
export function loadBranch(): string {
  try {
    return localStorage.getItem(BRANCH_KEY) ?? "main";
  } catch {
    return "main";
  }
}

export function saveBranch(branch: string): void {
  try {
    localStorage.setItem(BRANCH_KEY, branch);
  } catch {
    // ignore
  }
}

const MODELS_KEY = "bob:models-json";

/** The model registry JSON typed in Settings (browser-local, not in the workspace). */
export function loadModelsJson(): string {
  try {
    return localStorage.getItem(MODELS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveModelsJson(json: string): void {
  try {
    if (json.trim()) localStorage.setItem(MODELS_KEY, json);
    else localStorage.removeItem(MODELS_KEY);
  } catch {
    // ignore
  }
}

export type StorageMode = "browser" | "desktop";

/** Where BOB's tools operate: browser OPFS, or the desktop via the bridge. */
export function loadStorage(): StorageMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "desktop" ? "desktop" : "browser";
  } catch {
    return "browser";
  }
}

export function saveStorage(mode: StorageMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

/** URL of the local storage bridge (scripts/storage-server.mjs). */
export function loadStorageServer(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? "http://127.0.0.1:8795";
  } catch {
    return "http://127.0.0.1:8795";
  }
}

export function saveStorageServer(url: string): void {
  try {
    localStorage.setItem(SERVER_KEY, url);
  } catch {
    // ignore
  }
}
