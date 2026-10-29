/**
 * read_runs must reuse the shared run-log handle.
 *
 * The run log has exactly one connection in the browser: log-store's cached,
 * serial-queued handle (the `opfs-sahpool` VFS keeps one pooled connection per
 * file; the whole-file fallback loads the entire file into wasm memory on
 * open). A per-call read-only connection therefore costs another connection —
 * and, before the streaming VFS, failed outright with "Failed to allocate N
 * bytes" once the log outgrew the remaining wasm heap (the insight run's two
 * dead read_runs calls). So read_runs goes through that shared handle: one
 * open for the life of the session, no close per call, and every read waits
 * for the buffered event flush first.
 *
 * Run: `npm run test:read-runs-handle`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserTools } from "../web/src/agent/browser-tools.ts";
import { createNodePlatform } from "../src/platform/node.js";
import type { SqliteDatabase, SqliteFactory } from "../web/src/platform/types.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-readruns-"));
const base = createNodePlatform(workspace);

const opens: Array<{ path: string; readOnly: boolean; scratch?: boolean }> = [];
let closes = 0;
let prepared = 0;

const ROW = {
  run_id: "2026-10-24_10-00-00-1",
  definition_id: "trunk",
  seq: 7,
  branch_path: "trunk",
  kind: "emit",
  content: JSON.stringify({ value: { text: "hello from the log" } }),
};

const sqlite: SqliteFactory = {
  async open(dbPath, { readOnly, scratch }) {
    opens.push({ path: dbPath, readOnly, scratch });
    const db: SqliteDatabase = {
      async prepare(sql) {
        prepared += 1;
        // Open-time housekeeping probes (legacy-kind guard, size check) see
        // "nothing to do"; the run-log SELECT gets the sample row.
        const rows = sql.includes("kind = 'memory'")
          ? []
          : sql.includes("pragma_page_count")
            ? [{ bytes: 0 }]
            : [ROW];
        return {
          async all() {
            return rows;
          },
          async get() {
            return rows[0];
          },
          async run() {
            return { changes: 0, lastInsertRowid: 0 };
          },
          async columns() {
            return [];
          },
        };
      },
      async exec() {},
      async close() {
        closes += 1;
      },
    };
    return db;
  },
};

const platform = { ...base, sqlite };
let flushes = 0;
const tools = browserTools(platform, {
  flushLog: async () => {
    flushes += 1;
  },
});

try {
  const first = (await tools.read_runs.execute({ limit: 5 })) as {
    rows?: Array<{ text?: string }>;
  };
  assert.ok(Array.isArray(first.rows), "read_runs returns rows");
  assert.equal(first.rows?.[0]?.text, "hello from the log", "rows come back through the shared handle");
  assert.equal(opens.length, 1, "the first read opens the log once");
  assert.equal(opens[0].path, path.posix.join(workspace, "logs/grandma-kat.db"), "it opens the workspace run log");
  assert.equal(opens[0].readOnly, false, "read_runs shares the writable log-store handle");
  assert.equal(flushes, 1, "buffered events are flushed before the read");

  const preparedAtOpen = prepared;
  await tools.read_runs.execute({ limit: 10 });
  await tools.read_runs.execute({ type: "emit" });

  assert.equal(opens.length, 1, "later reads reuse the cached handle — no per-call open");
  assert.equal(closes, 0, "the shared handle is never closed per call");
  assert.equal(flushes, 3, "every read flushes the log first");
  assert.equal(prepared - preparedAtOpen, 2, "each read runs one prepared SELECT on the shared handle");

  console.log("read-runs-handle: one shared log connection reused across reads OK");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
