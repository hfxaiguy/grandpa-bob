/**
 * Browser settings: environment values used for models.json `${ENV}` key
 * interpolation. Stored in localStorage (a personal-app key store); never sent
 * anywhere except the configured LLM endpoint — and, when `exa_search` runs,
 * the Exa search endpoint.
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

const CDP_KEY = "bob:cdp";

/** Browser-level CDP socket handed over by `npm run chrome` (?cdp=…). */
export function loadCdp(): string {
  try {
    return localStorage.getItem(CDP_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCdp(url: string): void {
  try {
    if (url) localStorage.setItem(CDP_KEY, url);
    else localStorage.removeItem(CDP_KEY);
  } catch {
    // ignore
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

const STORAGE_MODES: StorageMode[] = ["browser", "desktop"];

/** Where BOB's tools operate: the browser's OPFS sandbox or the desktop bridge. */
export function loadStorage(): StorageMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "desktop" ? "desktop" : "browser";
  } catch {
    return "browser";
  }
}

export function saveStorage(mode: StorageMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, STORAGE_MODES.includes(mode) ? mode : "browser");
  } catch {
    // ignore
  }
}

/** Default loopback address of the storage bridge (scripts/storage-server.mjs). */
const DEFAULT_SERVER = "http://127.0.0.1:8795";

/**
 * Normalize a bridge URL. Only http(s) is allowed: a stale `file:///…` (or any
 * other scheme) in localStorage would otherwise be passed to `fetch`, which
 * Firefox reports as "Content at … may not load or link to file:///".
 * A bare `host:port` gets `http://`; an unusable value falls back to the
 * default instead of poisoning every request.
 */
export function normalizeStorageServer(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return DEFAULT_SERVER;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_SERVER;
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return DEFAULT_SERVER;
  }
}

/** URL of the local storage bridge (scripts/storage-server.mjs). */
export function loadStorageServer(): string {
  try {
    return normalizeStorageServer(localStorage.getItem(SERVER_KEY) ?? "");
  } catch {
    return DEFAULT_SERVER;
  }
}

export function saveStorageServer(url: string): void {
  const normalized = normalizeStorageServer(url);
  try {
    localStorage.setItem(SERVER_KEY, normalized);
  } catch {
    // ignore
  }
}

// ── telegram channel ─────────────────────────────────────────────────────

const TELEGRAM_KEY = "bob:telegram-channel";
/** The telegram API shares the storage bridge's port (src/index.ts). */
const DEFAULT_TELEGRAM = "http://127.0.0.1:8795";
/** The pre-merge standalone channel port; saved settings migrate off it. */
const LEGACY_TELEGRAM = "http://127.0.0.1:8091";

/** Same normalization rules as the storage bridge; empty → the default port. */
export function loadTelegramChannel(): string {
  try {
    const raw = localStorage.getItem(TELEGRAM_KEY) ?? "";
    if (!raw) return DEFAULT_TELEGRAM;
    const normalized = normalizeStorageServer(raw);
    return normalized === LEGACY_TELEGRAM ? DEFAULT_TELEGRAM : normalized;
  } catch {
    return DEFAULT_TELEGRAM;
  }
}

export function saveTelegramChannel(url: string): void {
  const normalized = normalizeStorageServer(url);
  try {
    localStorage.setItem(TELEGRAM_KEY, normalized);
  } catch {
    // ignore
  }
}
