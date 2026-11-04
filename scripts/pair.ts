/**
 * Desktop/server pairing console.
 *
 *   npm run pair                         # pair the active browser profile
 *   npm run pair -- --profile travel --mirror travel --exec git,make
 *   npm run pair -- --relay              # pair a phone through BobSwap
 *   npm run pair -- --yes                # approve without a prompt (CI)
 *   npm run pair -- --list
 *   npm run pair -- --revoke travel
 *
 * It talks to the running combined process (`npm run bob`) over its loopback
 * admin API, authenticating with ~/.bobkat/admin-key. Browsers never see that
 * key. The pairing code and SAS are printed here; nothing is written until the
 * operator approves.
 *
 * `--relay` creates the signaling channel on BobSwap instead of the loopback
 * mailbox. Only SDP/ICE go through the relay; workspace bytes, ops and voice
 * stay on the DTLS datachannel.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
// Load .env (the same file `npm run bob` reads) before parsing BOB_SYNC_RELAY*.
import "../src/config.js";
import { statePath } from "../src/state-dir.js";

const DEFAULT_URL = "http://127.0.0.1:8795";
const DEFAULT_RELAY_URL = "https://bobswap.hfxaiguy.com";

interface Args {
  profile: string;
  mirror: string;
  mirrorPath?: string;
  exec: string[];
  yes: boolean;
  list: boolean;
  revoke?: string;
  allow?: string;
  deny?: string;
  url: string;
  relay: boolean;
  relayUrl: string;
  relayKey?: string;
  debug: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    // Wildcard: pair the device once; the browser's active profile names the
    // first mirror, and the catalog covers every other profile too.
    profile: "*",
    mirror: "",
    exec: [],
    yes: false,
    list: false,
    url: process.env.BOB_PAIR_URL ?? DEFAULT_URL,
    relay: false,
    relayUrl: process.env.BOB_SYNC_RELAY?.trim() || DEFAULT_RELAY_URL,
    relayKey: process.env.BOB_SYNC_RELAY_KEY?.trim() || undefined,
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
    else if (flag === "--allow") args.allow = value();
    else if (flag === "--deny") args.deny = value();
    else if (flag === "--url") args.url = value();
    else if (flag === "--relay") args.relay = true;
    else if (flag === "--relay-url") {
      args.relay = true;
      args.relayUrl = value();
    } else if (flag === "--relay-key") {
      args.relay = true;
      args.relayKey = value();
    }
    else if (flag === "--debug" || flag === "-d") args.debug = true;
    else if (flag === "--help" || flag === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (!args.mirror && args.profile !== "*") args.mirror = args.profile;
  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run pair [options]

  --profile <name>      require this browser profile (default: any — device pairing)
  --mirror <name>       first profile's mirror folder (default: the profile name)
  --mirror-path <dir>   absolute folder path (default: ~/.bobkat/folders/<name>)
  --exec <a,b,...>      allowlisted executables for ops (default: none)
  --yes                 approve and confirm the phrase without prompting
  --list                show paired browser profiles
  --revoke <profile>    revoke a profile's client key
  --allow <profile>     allow this desktop profile for all paired devices
  --deny <profile>      veto this desktop profile for all paired devices
  --url <url>           admin API origin (default: ${DEFAULT_URL})
  --relay               create the code on BobSwap instead of the local mailbox
  --relay-url <url>     relay origin (default: ${DEFAULT_RELAY_URL})
  --relay-key <key>     BobSwap read key (default: BOB_SYNC_RELAY_KEY)
  --debug, -d           log admin API calls and every pairing event
                        (or set BOB_PAIR_DEBUG=1)

By default this pairs the device, not one profile: after approval both sides
exchange catalogs and each profile gets its own checkbox in the browser's
Profiles dialog. Use --profile only when you want to pin the tab's active
profile for the first mirror. --mirror and --mirror-path choose that first
folder independently; every other profile defaults to
~/.bobkat/folders/<name>.

--relay is for a phone on another network: the local mailbox is loopback-only.
In the browser use Sync… → Pair… → My desktop / server and enter the relay URL
plus the code. Only SDP/ICE touch the relay; files, ops and voice stay on the
datachannel.
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
    const body =
      init.body === undefined
        ? ""
        : ` ${JSON.stringify(init.body).replace(/("key"\s*:\s*")[^"]+(")/g, "$1***$2")}`;
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
      mirror: args.mirror || undefined,
      mirrorPath: args.mirrorPath,
      exec: args.exec,
      relay: args.relay ? { url: args.relayUrl, key: args.relayKey } : undefined,
    },
  });

  console.log(
    info.profile === "*"
      ? "browser:   any profile (device pairing; the tab's active profile names the first mirror)"
      : `browser:   profile "${info.profile}" (the tab must be on this profile)`,
  );
  console.log(
    args.mirror
      ? `mirror:    ${args.mirror} → ${args.mirrorPath ?? `~/.bobkat/folders/${args.mirror}`}`
      : `mirror:    default per profile → ~/.bobkat/folders/<profile>`,
  );
  console.log(`exec:      ${args.exec.length ? args.exec.join(", ") : "(none)"}`);
  if (args.relay) console.log(`relay:     ${args.relayUrl} (signaling only)`);
  console.log("");
  console.log(`code:      ${info.code}`);
  console.log("");
  console.log("In the browser: Sync… → Pair… → My desktop / server.");
  console.log(`Enter:     ${args.relay ? args.relayUrl : args.url} and the code above — no channel id.`);
  if (info.profile !== "*") {
    console.log("Tab on another profile? Stop (Ctrl-C) and rerun with --profile <name>.");
  }
  console.log("Waiting for the browser…\n");

  if (args.debug) {
    console.error(
      `[pair:debug] profile=${JSON.stringify(info.profile)} mirror=${JSON.stringify(args.mirror)} ` +
        `exec=${JSON.stringify(args.exec)} url=${args.url} session=${info.id}`,
    );
  }

  let after = -1;
  let approved = false;
  let connectedAt = 0;
  let modeHinted = false;
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
      if (event.type === "connected") {
        connectedAt = Date.now();
        console.log(`SAS: ${String(event.data.sas ?? "—")}`);
      }
      if (event.type === "sas") console.log(`verification phrase: ${String(event.data.sas ?? "—")}`);
      if (event.type === "awaiting-approval" && !approved) {
        console.log(`\nverification phrase: ${String(event.data.sas ?? "—")}`);
        console.log("Compare it with the phrase shown in the browser before approving.");
        const ok = args.yes
          ? true
          : await ask(
              `Confirm the phrase matches and approve profile "${info.profile}" with the capabilities above?`,
            );
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
    if (connectedAt && !approved && !modeHinted && Date.now() - connectedAt > 15_000) {
      modeHinted = true;
      console.log(
        "\nstill waiting for the browser to identify itself as a desktop client.\n" +
          "If its button says “Pair with browser”, it is on the tab-to-tab relay path:\n" +
          "stop, choose “My desktop / server”, set the mailbox URL to the relay URL\n" +
          "above, and rerun with a fresh code.",
      );
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
  if (args.allow || args.deny) {
    const name = args.allow ?? args.deny!;
    const allow = Boolean(args.allow);
    await api(args, `/admin/profiles/${encodeURIComponent(name)}/consent`, {
      method: "POST",
      body: { allow },
    });
    console.log(`${allow ? "allowed" : "denied"} desktop profile "${name}" for paired devices`);
    return;
  }
  await runPairing(args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
