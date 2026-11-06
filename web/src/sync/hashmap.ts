/**
 * Workspace → `{path: sha256}` map for the sync reconcile.
 *
 * Excludes what must never sync: git internals (each replica keeps its own
 * history), the run log (`logs/` — the OPFS run log lives under `.gpb-runlog`
 * which is not even a plain file, and the logical log travels as an event
 * stream over a paired channel instead, see `web/src/peer-log.ts`), the sync
 * journal itself (`.gpb-sync/`), uploaded attachment bins (`assets/inbox/`),
 * and SQLite databases/sidecars (they travel as SQL dumps, see db-sync.ts).
 */
import type { Platform } from "../platform/types";

const EXCLUDED = [
  /^\.git\//,
  /^\.gpb-/,
  /^logs\//,
  /^assets\/inbox\//,
  /(^|\/)\.gpb-sync\//,
  // Desktop mirror identity lives beside the workspace; it is machine-local
  // metadata, not profile content.
  /(^|\/)\.bob-profile\.json$/,
  // SQLite databases are live files, not workspace documents. A browser app
  // DB is a whole-file engine (sqlite-wasm loads it into memory and exports
  // the whole image after each commit), so a raw peer copy can race that
  // persist and has no version history to recover from. App DBs travel as
  // their deterministic SQL dumps under db/ instead (db-sync.ts); a raw copy
  // of a DB that is open (or mid-transaction) can be torn, and the receiving
  // side has no journal to repair it. Sidecars are runtime state, not data.
  /^[^/]+\.db$/,
  /\.db-(?:journal|wal|shm)$/,
  // Build/dependency trees are machine-local; syncing them would flood the
  // engine (and a mirror folder after `npm install`/`cargo build`).
  /(^|\/)node_modules\//,
  /(^|\/)\.venv\//,
  /(^|\/)__pycache__\//,
  /(^|\/)\.cache\//,
  /(^|\/)target\//,
  // Conflict copies are sync-generated: they must never round-trip (a copy
  // of a copy of a copy) — the plan's rule, enforced here.
  /\.conflict-[0-9T-]+$/,
];

/**
 * Whether a workspace-relative path must never sync. Exported because the
 * receive side applies the same rule: a mixed-version or misbehaving peer can
 * still advertise a path this replica excludes (its map predates the rule),
 * and applying it would reintroduce exactly the raw-file write the exclusion
 * exists to prevent.
 */
export function excluded(rel: string): boolean {
  return EXCLUDED.some((re) => re.test(rel));
}

/**
 * One syncable file. `mtime` is the wall-clock freshness used when neither
 * replica has a journaled edit for the path (see SyncEngine.conflictWinner).
 * It is 0 when the adapter cannot report a timestamp.
 */
export type HashEntry = { hash: string; bytes: number; mtime: number };
export type Hashmap = Record<string, HashEntry>;

/** Walk the workspace and hash every file (binary-safe). */
export async function buildHashmap(platform: Platform, root: string): Promise<Hashmap> {
  const map: Hashmap = {};
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await platform.fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (excluded(childRel)) continue;
      const childAbs = platform.path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else {
        const bytes = await (platform.fs as { readFileBytes?: (p: string) => Promise<Uint8Array> })
          .readFileBytes?.(childAbs)
          ?.catch(() => undefined);
        const content =
          bytes ??
          (await platform.fs
            .readFile(childAbs, "utf8")
            .then((t) => new TextEncoder().encode(t))
            .catch(() => undefined));
        if (!content) continue;
        const detail = await platform.fs.statDetail?.(childAbs).catch(() => null);
        map[childRel] = {
          hash: hashBytes(platform, content),
          bytes: content.length,
          mtime: detail?.mtimeMs ?? 0,
        };
      }
    }
  }
  await walk(root, "");
  return map;
}

export function hashBytes(platform: Platform, bytes: Uint8Array): string {
  // sha256hex hashes text; hash the binary via its base64-safe latin1 form.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return platform.crypto.sha256hex(btoa(binary));
}
