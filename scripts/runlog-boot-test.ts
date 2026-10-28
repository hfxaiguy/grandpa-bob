/**
 * Run-log boot resilience: a failed schema step must not take the log down.
 *
 * The incident this guards: OPFS writes fail (Gecko reports a bare
 * `UnknownError: Unknown failure`), so the run log has to open through the
 * whole-file fallback engine, where `CREATE INDEX idx_calls_kind` can run out
 * of wasm heap (SQLITE_NOMEM). The DDL used to run as one statement list, so
 * that failure rejected the log's first open and every read/write behind it.
 * Now the tables are created first and the index build is best-effort; the
 * next open retries it, and until then the log works with full scans.
 *
 * Run: `npm run test:runlog-boot`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNodePlatform } from "../src/platform/node.js";
import type { Platform } from "../web/src/platform/types";
import {
  listSessions,
  RUN_LOG_DDL,
  withLogDb,
  writeLabel,
} from "../web/src/agent/log-store.ts";

const dir = await mkdtemp(path.join(os.tmpdir(), "gpb-runlog-boot-"));
const workspace = path.join(dir, "workspace");

/** Fail `CREATE INDEX` the way an exhausted wasm heap does; pass through the rest. */
function platformWithFailingIndex(base: Platform, fail: boolean): Platform {
  return {
    ...base,
    sqlite: {
      async open(file, opts) {
        const db = await base.sqlite.open(file, opts);
        return {
          ...db,
          async exec(sql: string) {
            if (fail && /CREATE\s+INDEX/i.test(sql)) {
              throw Object.assign(new Error("sqlite3_step() rc= 7 SQLITE_NOMEM SQL = " + sql), {
                resultCode: 7,
              });
            }
            await db.exec(sql);
          },
        };
      },
      exportBytes: base.sqlite.exportBytes,
    },
  };
}

async function indexNames(platform: Platform): Promise<string[]> {
  const rows = (await withLogDb(platform, async (db) => {
    return (await (
      await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_calls_kind'")
    ).all()) as Array<{ name: string }>;
  })) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

assert.ok(RUN_LOG_DDL.includes("CREATE TABLE IF NOT EXISTS calls"), "DDL keeps the tables");
assert.ok(RUN_LOG_DDL.includes("idx_calls_kind"), "DDL keeps the index");

const warnings: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
};

try {
  // ── 1. the index build fails; the log still opens and serves writes ─────
  const broken = platformWithFailingIndex(createNodePlatform(workspace), true);
  await writeLabel(broken, "web:boot", "survives a bad index");
  assert.deepEqual(await indexNames(broken), [], "the failed index must not claim to exist");
  assert.ok(
    warnings.some((line) => line.includes("idx_calls_kind")),
    `expected an index warning, got ${JSON.stringify(warnings)}`,
  );

  const sessions = await listSessions(broken, (key) => key);
  assert.equal(sessions.length, 1, "the marker written after the failed index is readable");
  assert.equal(sessions[0].label, "survives a bad index");

  // ── 2. the next open (same file, healthy engine) builds the index ───────
  const healed = platformWithFailingIndex(createNodePlatform(workspace), false);
  assert.deepEqual(await indexNames(healed), ["idx_calls_kind"], "the next boot retries the index");

  console.log("runlog-boot-test: failed index build degrades to full scans and is retried OK");
} finally {
  console.warn = warn;
  await rm(dir, { recursive: true, force: true });
}
