/**
 * Read the desktop copy of a paired profile's run log.
 *
 * While a tab is paired to this desktop, its engine rows stream over the
 * peer control channel into `~/.bobkat/peers/<profile>/logs/grandma-kat.db`
 * (see src/bridge/peer-log.ts). That copy is what makes browser errors
 * visible on this machine — the file itself never syncs, and db-sync skips
 * the run log by design.
 *
 *   npm run peer:log -- --profile linkedin              # latest errors
 *   npm run peer:log -- --profile linkedin --all        # latest rows of any kind
 *   npm run peer:log -- --profile linkedin --kind llm_error --limit 5
 *   npm run peer:log -- --profile linkedin --stats
 *   npm run peer:log -- --profile linkedin --follow     # tail new rows
 *
 * It talks to the running combined process (`npm run bob`) over its loopback
 * admin API, authenticating with ~/.bobkat/admin-key.
 */
import { readFile } from "node:fs/promises";
import { statePath } from "../src/state-dir.js";

const DEFAULT_URL = "http://127.0.0.1:8795";
const DEFAULT_KINDS = ["llm_error", "tool_error"];

interface Args {
  profile: string;
  kinds: string[];
  /** Default window: engine/tool errors plus failed turns (server-side filter). */
  errors: boolean;
  limit: number;
  after: number;
  follow: boolean;
  stats: boolean;
  json: boolean;
  url: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    profile: "default",
    kinds: [],
    errors: true,
    limit: 20,
    after: 0,
    follow: false,
    stats: false,
    json: false,
    url: process.env.BOB_PAIR_URL ?? DEFAULT_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--profile") args.profile = value();
    else if (flag === "--kind") {
      args.kinds = value().split(",").map((k) => k.trim()).filter(Boolean);
      args.errors = false;
    } else if (flag === "--all") {
      args.kinds = [];
      args.errors = false;
    } else if (flag === "--errors") args.errors = true;
    else if (flag === "--limit") args.limit = Math.max(1, Number(value()) || 20);
    else if (flag === "--after") args.after = Math.max(0, Number(value()) || 0);
    else if (flag === "--follow" || flag === "--tail") args.follow = true;
    else if (flag === "--stats") args.stats = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--url") args.url = value();
    else if (flag === "--help" || flag === "-h") {
      console.log(help());
      process.exit(0);
    } else throw new Error(`unknown option: ${flag}`);
  }
  return args;
}

function help(): string {
  return `Usage: npm run peer:log [options]

  --profile <name>   paired browser profile (default: default)
  --kind <a,b,...>   exact kinds to show (default: errors only: ${DEFAULT_KINDS.join(", ")},
                     plus turns whose marker says status=error)
  --errors           errors only (the default window)
  --all              every kind (same as no kind/error filter)
  --limit <n>        rows in the window (default: 20, max: 1000)
  --after <seq>      only rows with seq > n
  --follow           keep polling for new rows
  --stats            epoch/cursor/kind counts only
  --json             raw JSON instead of formatted rows
  --url <url>        admin API origin (default: ${DEFAULT_URL})

The desktop copy fills only while the profile's tab is paired and open; rows
written before this feature existed live in the tab's OPFS log and stream in
on its next connection.
`;
}

async function adminKey(): Promise<string> {
  const file = statePath("admin-key");
  try {
    const raw = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{64}$/.test(raw)) return raw;
  } catch {
    /* handled below */
  }
  throw new Error(`admin key not found at ${file} — start \`npm run bob\` first`);
}

interface PeerLogEvent {
  seq: number;
  run_id?: string;
  definition_id?: string;
  branch_path?: string | null;
  iteration?: number | null;
  scope_id?: number | null;
  kind: string;
  content?: unknown;
}

interface PeerLogResponse {
  profile: string;
  epoch: string;
  cursor: number;
  total: number;
  rows: PeerLogEvent[];
}

interface PeerLogStatsResponse {
  profile: string;
  epoch: string;
  cursor: number;
  total: number;
  kinds: Array<{ kind: string; count: number }>;
}

async function api<T>(args: Args, route: string): Promise<T> {
  const key = await adminKey();
  const url = `${args.url.replace(/\/$/, "")}${route}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "content-type": "application/json", "x-bob-admin": key },
    });
  } catch {
    throw new Error(`cannot reach ${args.url} — is \`npm run bob\` running?`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function oneLine(text: string, max = 1000): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The most useful field of a row's content, else a compact JSON preview. */
function describe(event: PeerLogEvent): string {
  const content = event.content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    for (const key of ["error", "message", "reason", "text", "input", "name", "tool", "model"]) {
      const value = c[key];
      if (typeof value === "string" && value.trim()) return oneLine(`${key}: ${value}`);
    }
  }
  let json = "";
  try {
    json = JSON.stringify(content ?? null);
  } catch {
    json = String(content);
  }
  return oneLine(json ?? "null");
}

function printRow(event: PeerLogEvent): void {
  const run = event.run_id ? ` ${event.run_id}` : "";
  console.log(`${String(event.seq).padStart(7)}  ${event.kind.padEnd(12)}${run}  ${describe(event)}`);
}

function logUrl(args: Args, after: number): string {
  const params = new URLSearchParams({ limit: String(args.limit) });
  if (args.errors) params.set("errors", "1");
  else if (args.kinds.length) params.set("kind", args.kinds.join(","));
  const from = Math.max(after, args.after);
  if (from > 0) params.set("after", String(from));
  return `/admin/peers/${encodeURIComponent(args.profile)}/log?${params}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.stats) {
    const stats = await api<PeerLogStatsResponse>(args, `/admin/peers/${encodeURIComponent(args.profile)}/log?stats=1`);
    if (args.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }
    console.log(`profile: ${stats.profile}`);
    console.log(`epoch:   ${stats.epoch || "(never streamed)"}`);
    console.log(`cursor:  ${stats.cursor}`);
    console.log(`rows:    ${stats.total}`);
    for (const { kind, count } of stats.kinds) console.log(`  ${String(count).padStart(7)}  ${kind}`);
    return;
  }

  const first = await api<PeerLogResponse>(args, logUrl(args, 0));
  if (args.json && !args.follow) {
    console.log(JSON.stringify(first, null, 2));
    return;
  }
  if (!args.json) {
    if (!first.epoch) {
      console.log(
        `profile ${args.profile}: no log stream yet — pair the tab (Sync… → Desktop / server) and reload it so it can stream the backlog.`,
      );
    }
    if (first.rows.length === 0 && first.epoch) {
      const filter = args.errors
        ? " errors"
        : args.kinds.length
          ? ` for ${args.kinds.join(", ")}`
          : "";
      console.log(`profile ${args.profile}: no rows${filter} (cursor ${first.cursor}, ${first.total} stored).`);
    }
  }
  for (const row of first.rows) {
    if (args.json) console.log(JSON.stringify(row));
    else printRow(row);
  }

  if (!args.follow) return;
  let after = first.cursor;
  // The follow loop is a poll, not a push: this CLI only has the admin API.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const next = await api<PeerLogResponse>(args, logUrl(args, after));
    for (const row of next.rows) {
      if (args.json) console.log(JSON.stringify(row));
      else printRow(row);
    }
    after = Math.max(after, next.cursor);
  }
}

try {
  await main();
} catch (err) {
  console.error(`peer-log: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
