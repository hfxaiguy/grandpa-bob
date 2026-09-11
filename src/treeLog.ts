// src/treeLog.ts
//
// Read-only access to the grandma-kat SQLite event log (`calls` table),
// the canonical "read the grandma-kat log" API for apps. The logger that
// writes this DB lives in the grandma-kat package (SqliteLogger); this
// module only READS it so the web/admin UI and any sibling app can tail
// tree events without touching the writer.

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface TreeEvent {
  runId: string;
  seq: number;
  branchPath: string;
  iteration: number;
  scopeId: number | null;
  kind: string;
  content: Record<string, unknown> | null;
}

export interface TreeRunSummary {
  runId: string;
  definitionId: string;
  count: number;
  firstSeq: number;
  lastSeq: number;
}

export interface TreeRun extends TreeRunSummary {
  events: TreeEvent[];
}

/** Log DB path from a workspace dir — mirrors index.ts's `logs/grandma-kat.db`. */
export function logDbPath(workspaceDir: string): string {
  return path.join(workspaceDir, "logs", "grandma-kat.db");
}

function parseContent(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Open a live, read-only handle on the log DB. Caller owns close().
 * Throws if the DB doesn't exist (e.g. no runs yet).
 */
export class TreeLogReader {
  private db: DatabaseSync;

  constructor(public readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  maxSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM calls").get() as { n: number };
    return row.n;
  }

  eventsSince(seq: number): TreeEvent[] {
    const rows = this.db.prepare("SELECT * FROM calls WHERE seq > ? ORDER BY seq").all(seq);
    return rows.map((r) => this.toEvent(r as any));
  }

  listRuns(limit = 50): TreeRunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, definition_id, COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi
         FROM calls GROUP BY run_id ORDER BY hi DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r: any) => ({
      runId: r.run_id,
      definitionId: r.definition_id,
      count: r.n,
      firstSeq: r.lo,
      lastSeq: r.hi,
    }));
  }

  run(runId: string): TreeRun {
    const summaryRow = this.db
      .prepare(
        `SELECT run_id, definition_id, COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi
         FROM calls WHERE run_id = ? GROUP BY run_id`,
      )
      .get(runId) as any;
    const events = this.db
      .prepare("SELECT * FROM calls WHERE run_id = ? ORDER BY seq")
      .all(runId)
      .map((r) => this.toEvent(r as any));
    return {
      runId,
      definitionId: summaryRow?.definition_id ?? "",
      count: summaryRow?.n ?? events.length,
      firstSeq: summaryRow?.lo ?? events[0]?.seq ?? 0,
      lastSeq: summaryRow?.hi ?? events[events.length - 1]?.seq ?? 0,
      events,
    };
  }

  private toEvent(r: any): TreeEvent {
    return {
      runId: r.run_id,
      seq: r.seq,
      branchPath: r.branch_path ?? "",
      iteration: r.iteration ?? 0,
      scopeId: r.scope_id ?? null,
      kind: r.kind,
      content: parseContent(r.content),
    };
  }

  close(): void {
    this.db.close();
  }
}
