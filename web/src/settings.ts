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
