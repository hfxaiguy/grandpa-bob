/**
 * Desktop/server pairing console.
 *
 *   npm run pair                         # pair the active browser profile
 *   npm run pair -- --profile travel --mirror travel --exec git,make
 *   npm run pair -- --yes                # approve without a prompt (CI)
 *   npm run pair -- --list
 *   npm run pair -- --revoke travel
 *
 * It talks to the running combined process (`npm run bob`) over its loopback
 * admin API, authenticating with ~/.bobkat/admin-key. Browsers never see that
 * key. The pairing code and SAS are printed here; nothing is written until the
 * operator approves.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { statePath } from "../src/state-dir.js";

const DEFAULT_URL = "http://127.0.0.1:8795";

interface Args {
  profile: string;
  mirror: string;
  mirrorPath?: string;
  exec: string[];
  yes: boolean;
  list: boolean;
  revoke?: string;
  url: string;
  debug: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    profile: "default",
    mirror: "",
    exec: [],
    yes: false,
    list: false,
    url: process.env.BOB_PAIR_URL ?? DEFAULT_URL,
    debug: /^(1|true|yes)$/i.test(process.env.BOB_PAIR_DEBUG ?? ""),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--profile") args.profile = value();
    else if (flag === "--mirror") args.mirror = value();
    else if (flag === "--mirror-path") args.mirrorPath = value();
    else if (flag === "--exec") args.exec = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--yes") args.yes = true;
    else if (flag === "--list") args.list = true;
    else if (flag === "--revoke") args.revoke = value();
    else if (flag === "--url") args.url = value();
    else if (flag === "--debug" || flag === "-d") args.debug = true;
    else if (flag === "--help" || flag === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (!args.mirror) args.mirror = args.profile;
  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run pair [options]

  --profile <name>      browser profile to pair (default: default)
  --mirror <name>       mirror folder name (default: the profile name)
  --mirror-path <dir>   absolute folder path (default: ~/.bobkat/folders/<name>)
  --exec <a,b,...>      allowlisted executables for ops (default: none)
  --yes                 approve without prompting
  --list                show paired profiles
  --revoke <profile>    revoke a profile's client key
  --url <url>           admin API origin (default: ${DEFAULT_URL})
  --debug, -d           log admin API calls and every pairing event
                        (or set BOB_PAIR_DEBUG=1)

The tab's active browser profile must match --profile. --mirror and
--mirror-path choose the desktop folder independently, so one desktop can host
a separate mirror per browser profile.
`);
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

async function api<T>(
  args: Args,
  route: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const key = await adminKey();
  const method = init.method ?? "GET";
  const url = `${args.url.replace(/\/$/, "")}${route}`;
  const isEventPoll = /\/admin\/pairing\/[^/]+\/events/.test(route);
  if (args.debug && !isEventPoll) {
    const body = init.body === undefined ? "" : ` ${JSON.stringify(init.body)}`;
    console.error(`[pair:debug] ${method} ${url}${body}`);
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-bob-admin": key,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    if (args.debug) console.error(`[pair:debug] ${method} ${url} → network error`);
    throw new Error(`cannot reach ${args.url} — is \`npm run bob\` running?`);
  }
  if (args.debug && (!isEventPoll || !res.ok)) {
    console.error(`[pair:debug] ${method} ${url} → ${res.status} ${res.statusText} (${Date.now() - started}ms)`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

interface PairingEvent {
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

interface PairingInfo {
  id: string;
  profile: string;
  channelId: string;
  code: string;
  capabilities: { mirror?: string; exec: string[] };
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function runPairing(args: Args): Promise<void> {
  const info = await api<PairingInfo>(args, "/admin/pairing", {
    method: "POST",
    body: {
      profile: args.profile,
      mirror: args.mirror,
      mirrorPath: args.mirrorPath,
      exec: args.exec,
    },
  });

  console.log(`browser:   profile "${info.profile}" (the tab must be on this profile)`);
  console.log(`mirror:    ${args.mirror} → ${args.mirrorPath ?? `~/.bobkat/folders/${args.mirror}`}`);
  console.log(`exec:      ${args.exec.length ? args.exec.join(", ") : "(none)"}`);
  console.log("");
  console.log(`code:      ${info.code}`);
  console.log("");
  console.log(`In the browser (profile "${info.profile}"): Sync… → Pair… → Desktop / server.`);
  console.log(`Enter:     ${args.url} and the code above — no channel id.`);
  console.log("Tab on another profile? Stop (Ctrl-C) and rerun with --profile <name>.");
  console.log("Waiting for the browser…\n");

  if (args.debug) {
    console.error(
      `[pair:debug] profile=${JSON.stringify(info.profile)} mirror=${JSON.stringify(args.mirror)} ` +
        `exec=${JSON.stringify(args.exec)} url=${args.url} session=${info.id}`,
    );
  }

  let after = -1;
  let approved = false;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const view = await api<{ events: PairingEvent[]; done: boolean }>(
      args,
      `/admin/pairing/${info.id}/events?after=${after}`,
    );
    for (const event of view.events) {
      after = Math.max(after, event.seq);
      if (args.debug) {
        console.error(
          `[pair:debug] #${event.seq} ${event.at} ${event.type} ${JSON.stringify(event.data ?? {})}`,
        );
      }
      if (event.type === "joined") console.log("browser joined the channel");
      if (event.type === "connected") console.log(`SAS: ${String(event.data.sas ?? "—")}`);
      if (event.type === "sas") console.log(`verification phrase: ${String(event.data.sas ?? "—")}`);
      if (event.type === "awaiting-approval" && !approved) {
        console.log(`\nverification phrase: ${String(event.data.sas ?? "—")}`);
        console.log("Compare it with the phrase shown in the browser before approving.");
        const ok = args.yes ? true : await ask(`Approve profile "${info.profile}" with the capabilities above?`);
        if (!ok) {
          await api(args, `/admin/pairing/${info.id}/deny`, { method: "POST", body: {} });
          console.log("pairing denied");
          process.exit(1);
        }
        await api(args, `/admin/pairing/${info.id}/approve`, {
          method: "POST",
          body: { approve: true },
        });
        approved = true;
      }
      if (event.type === "paired") {
        console.log("\npaired. The browser will pin this server's key.");
        return;
      }
      if (event.type === "denied") {
        console.error("pairing denied");
        process.exit(1);
      }
      if (event.type === "error") {
        console.error(`pairing failed: ${String(event.data.message ?? "unknown error")}`);
        process.exit(1);
      }
    }
    if (args.debug && (view.events.length || view.done)) {
      console.error(`[pair:debug] poll after=${after} events=${view.events.length} done=${view.done}`);
    }
    if (view.done) {
      console.log("pairing session closed");
      return;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("timed out waiting for the browser");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    const data = await api<{
      peers: Array<{
        profile: string;
        fingerprint: string;
        capabilities: { mirror?: string; mirrorPath?: string; exec: string[] };
      }>;
    }>(args, "/admin/peers");
    if (!data.peers.length) console.log("no paired profiles");
    for (const peer of data.peers) {
      const mirror = peer.capabilities.mirror ?? peer.profile;
      const path = peer.capabilities.mirrorPath ?? `~/.bobkat/folders/${mirror}`;
      const exec = Array.isArray(peer.capabilities.exec) ? peer.capabilities.exec : [];
      console.log(
        `${peer.profile} · mirror ${mirror} → ${path} · exec: ${exec.join(",") || "none"} · ${peer.fingerprint}`,
      );
    }
    return;
  }
  if (args.revoke) {
    await api(args, `/admin/peers/${encodeURIComponent(args.revoke)}/revoke`, { method: "POST", body: {} });
    console.log(`revoked ${args.revoke}`);
    return;
  }
  await runPairing(args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
