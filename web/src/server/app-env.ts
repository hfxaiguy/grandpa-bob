/**
 * Workspace-owned env declarations.
 *
 * An app may drop `app/<name>/env.json` next to its tree to ask the Settings
 * page for named credential fields. BOB only knows how to render the declared
 * keys; the app name, label, description and placeholder all come from the
 * workspace. The browser backend adds these to `/api/status` as `appEnv`.
 *
 * Shape (either a bare array or `{ "env": [ … ] }`):
 *
 *   [{ "name": "FORWARD_EMAIL_API_KEY",
 *      "label": "Forward Email API key",
 *      "description": "…", "secret": true,
 *      "placeholder": "…" }]
 */
import type { Platform } from "../platform/types";

export interface AppEnvField {
  app: string;
  name: string;
  label: string;
  description: string;
  secret: boolean;
  placeholder: string;
}

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Every app's declared env fields, deduped by key (the first declaration wins). */
export async function readAppEnvDeclarations(platform: Platform): Promise<AppEnvField[]> {
  const out: AppEnvField[] = [];
  const seen = new Set<string>();
  try {
    const appDir = platform.path.join(platform.workspaceRoot, "app");
    const apps = await platform.fs.readdir(appDir, { withFileTypes: true });
    for (const entry of apps) {
      if (!entry.isDirectory()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(
          await platform.fs.readFile(platform.path.join(appDir, entry.name, "env.json"), "utf8"),
        );
      } catch {
        continue;
      }
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { env?: unknown[] } | null)?.env)
          ? (raw as { env: unknown[] }).env
          : [];
      for (const item of list) {
        const it = item as {
          name?: unknown;
          label?: unknown;
          description?: unknown;
          secret?: unknown;
          placeholder?: unknown;
        };
        const name = typeof it?.name === "string" ? it.name.trim() : "";
        if (!ENV_KEY_RE.test(name) || seen.has(name)) continue;
        seen.add(name);
        out.push({
          app: entry.name,
          name,
          label: typeof it.label === "string" && it.label.trim() ? it.label.trim() : name,
          description: typeof it.description === "string" ? it.description : "",
          secret: it.secret === true,
          placeholder: typeof it.placeholder === "string" ? it.placeholder : "",
        });
      }
    }
  } catch {
    /* no app dir */
  }
  return out;
}
