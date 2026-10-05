// Secret config files requested by workspace apps.
//
// An app declares what it needs in `app/<name>/secrets.json`:
//
//   [{ "name": "google-service-account.json",
//      "description": "Service account JSON for the Calendar API",
//      "contentType": "application/json" }]
//
// The user uploads the file from the WebUI (settings → app secrets). The
// bytes land in a sqlite database OUTSIDE the workspace by default
// (~/.grandpa-bob/secrets.db, SECRETS_DB overrides) — the workspace tree
// syncs over git, is readable by the bot's file tools and rides along in
// backups, so credentials must not live there. App tools read ONLY their
// own app's secrets through the context object the loader passes to
// execute().

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SecretRequest {
  app: string;
  name: string;
  description: string;
  contentType: string | null;
  /**
   * Optional key schema for the key/value editor shown for JSON secrets:
   * `{ "auth.token": "hint", "from": "…" }`. Dotted keys become nested.
   */
  fields?: Record<string, string>;
}

export interface SecretInfo {
  name: string;
  contentType: string | null;
  updatedAt: string;
  size: number;
}

export interface SecretRecord extends SecretInfo {
  app: string;
  content: Buffer;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Secret names are opaque keys, never paths — reject anything smellier. */
export function validSecretName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("..");
}

const KEY_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * A JSON secret field key: a dotted path like `auth.token`. No leading,
 * trailing or doubled dots — the same shape the WebUI's editor accepts.
 */
export function validSecretKey(key: string): boolean {
  return KEY_RE.test(key) && !key.startsWith(".") && !key.endsWith(".") && !key.includes("..");
}

/** Set a dotted path on a plain object, creating intermediate objects. */
function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Remove a dotted path from a plain object. */
function delPath(obj: Record<string, unknown>, key: string): void {
  const parts = key.split(".");
  let cur: Record<string, unknown> | undefined = obj;
  for (let i = 0; i < parts.length - 1 && cur; i += 1) {
    const next: unknown = cur[parts[i]];
    cur = next && typeof next === "object" && !Array.isArray(next) ? (next as Record<string, unknown>) : undefined;
  }
  if (cur) delete cur[parts[parts.length - 1]];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_secrets (
  app          TEXT NOT NULL,
  name         TEXT NOT NULL,
  content      BLOB NOT NULL,
  content_type TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (app, name)
)`;

export class SecretsStore {
  readonly dbPath: string;
  private db: DatabaseSync;

  /** @param dbPath absolute path of the sqlite file (parent auto-created). */
  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbPath);
    // Same rules as the run log: readers (upload routes, app tools) must
    // never starve the writer, and contention waits instead of throwing.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    try { fs.chmodSync(this.dbPath, 0o600); } catch { /* best effort */ }
  }

  /** Stored secrets, newest first. Never includes the content bytes. */
  list(app?: string): (SecretInfo & { app: string })[] {
    const rows = app
      ? this.db.prepare("SELECT app, name, content_type, length(content) AS size, updated_at FROM app_secrets WHERE app = ? ORDER BY name").all(app)
      : this.db.prepare("SELECT app, name, content_type, length(content) AS size, updated_at FROM app_secrets ORDER BY app, name").all();
    return (rows as Record<string, unknown>[]).map((r) => ({
      app: String(r.app),
      name: String(r.name),
      contentType: r.content_type == null ? null : String(r.content_type),
      size: Number(r.size ?? 0),
      updatedAt: String(r.updated_at),
    }));
  }

  get(app: string, name: string): SecretRecord | null {
    const row = this.db
      .prepare("SELECT app, name, content, content_type, updated_at FROM app_secrets WHERE app = ? AND name = ?")
      .get(app, name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      app: String(row.app),
      name: String(row.name),
      content: Buffer.from(row.content as Uint8Array),
      contentType: row.content_type == null ? null : String(row.content_type),
      updatedAt: String(row.updated_at),
      size: Buffer.byteLength(row.content as Uint8Array),
    };
  }

  put(app: string, name: string, content: Buffer, contentType?: string | null): void {
    this.db
      .prepare(
        `INSERT INTO app_secrets (app, name, content, content_type, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app, name) DO UPDATE SET
           content = excluded.content,
           content_type = excluded.content_type,
           updated_at = excluded.updated_at`,
      )
      .run(app, name, content, contentType ?? null, new Date().toISOString());
  }

  /**
   * Merge fields into a JSON secret without replacing the rest. Each key is a
   * dotted path (`auth.token` → `{ auth: { token } }`); a `null` value removes
   * that path. Throws when the stored bytes exist but are not a JSON object —
   * replace those with `put()`.
   */
  setFields(app: string, name: string, patch: Record<string, string | null>): Record<string, unknown> {
    const existing = this.get(app, name);
    let current: Record<string, unknown> = {};
    if (existing) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing.content.toString("utf8"));
      } catch {
        throw new Error("the stored secret is not JSON — replace it instead");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("the stored secret is not a JSON object — replace it instead");
      }
      current = parsed as Record<string, unknown>;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delPath(current, key);
      else setPath(current, key, value);
    }
    this.put(app, name, Buffer.from(JSON.stringify(current, null, 2)), "application/json");
    return current;
  }

  delete(app: string, name: string): boolean {
    const before = this.db
      .prepare("SELECT 1 FROM app_secrets WHERE app = ? AND name = ?")
      .get(app, name);
    if (!before) return false;
    this.db.prepare("DELETE FROM app_secrets WHERE app = ? AND name = ?").run(app, name);
    return true;
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

/**
 * Every secret an app asked for: `app/<dir>/secrets.json`, an array (or
 * `{ "secrets": [...] }`) of `{ name, description?, contentType? }`.
 * Invalid or path-like names are skipped with a warning — a manifest must
 * never be able to steer uploads outside its own app.
 */
export async function listSecretRequests(workspace: string): Promise<SecretRequest[]> {
  const appsDir = path.join(workspace, "app");
  const entries = await fs.promises.readdir(appsDir, { withFileTypes: true }).catch(() => []);
  const out: SecretRequest[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || !validSecretName(entry.name)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.promises.readFile(path.join(appsDir, entry.name, "secrets.json"), "utf8"));
    } catch {
      continue; // no manifest — the app asks for nothing
    }
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { secrets?: unknown })?.secrets) ? (raw as { secrets: unknown[] }).secrets : [];
    for (const item of list) {
      const it = item as { name?: unknown; description?: unknown; contentType?: unknown; fields?: unknown };
      const name = typeof it?.name === "string" ? it.name.trim() : "";
      if (!validSecretName(name)) {
        console.warn(`[secrets] ${entry.name}: ignoring invalid secret name ${JSON.stringify(it?.name)}`);
        continue;
      }
      out.push({
        app: entry.name,
        name,
        description: typeof it.description === "string" ? it.description : "",
        contentType: typeof it.contentType === "string" ? it.contentType : null,
        ...(it.fields && typeof it.fields === "object" && !Array.isArray(it.fields)
          ? {
              fields: Object.fromEntries(
                Object.entries(it.fields as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : ""]),
              ),
            }
          : {}),
      });
    }
  }
  return out;
}
