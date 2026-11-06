/**
 * Speech verification: what is reachable and configured on this machine.
 *
 *   npm run verify:speech
 *
 * Keys normally live in Settings → Speech (browser storage), so this script
 * reads them from the environment for a one-off probe:
 *   ASSEMBLYAI_API_KEY=… RIME_API_KEY=… npm run verify:speech
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type State = "ok" | "fail" | "skip";
interface Result {
  name: string;
  state: State;
  detail: string;
}
const results: Result[] = [];
const add = (name: string, state: State, detail: string): void => {
  results.push({ name, state, detail });
};

async function probe(name: string, url: string, ok: (status: number) => boolean): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    add(name, ok(res.status) ? "ok" : "fail", `HTTP ${res.status} · ${url}`);
  } catch (err) {
    add(name, "fail", `${err instanceof Error ? err.message : String(err)} · ${url}`);
  }
}

// Local STT (the servers the desktop calls).
const whisper = process.env.WHISPER_URL ?? "http://127.0.0.1:8178";
await probe("Whisper STT server", whisper, (status) => status < 500);

const sherpa = process.env.SHERPA_URL?.trim();
if (sherpa) {
  add("Sherpa STT server", "skip", `WebSocket server (${sherpa}) — verified by recording`);
} else {
  add("Sherpa STT server", "skip", "SHERPA_URL not set");
}

// Local TTS.
const kitten = (process.env.KITTEN_TTS_URL ?? "http://127.0.0.1:8185").replace(/\/$/, "");
try {
  const res = await fetch(`${kitten}/health`, { signal: AbortSignal.timeout(4000) });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; loaded?: boolean };
  add(
    "KittenTTS server",
    res.ok && body.ok !== false ? "ok" : "fail",
    `HTTP ${res.status} · ${kitten} · loaded=${body.loaded ?? "?"}`,
  );
} catch (err) {
  add(
    "KittenTTS server",
    "skip",
    `not running (${err instanceof Error ? err.message : String(err)}) — start it with \`npm run tts:up\``,
  );
}

try {
  await execFileAsync("python3", ["-c", "import kittenml"]);
  add("kittenml package", "ok", "installed");
} catch {
  add("kittenml package", "skip", "not installed — `pip install kittenml`");
}

// Cloud STT: AssemblyAI (CORS check happens in the browser; this probes the key).
const aai = process.env.ASSEMBLYAI_API_KEY?.trim();
if (!aai) {
  add("AssemblyAI key", "skip", "set ASSEMBLYAI_API_KEY to probe (or use Settings → Speech)");
} else {
  try {
    const res = await fetch("https://sync.assemblyai.com/v1/transcribe", {
      method: "POST",
      headers: { authorization: aai, "x-aai-model": "universal-3-5-pro" },
      body: new FormData(),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) add("AssemblyAI key", "fail", "rejected (Invalid API key)");
    else if (res.ok || res.status === 400 || res.status === 422) add("AssemblyAI key", "ok", "accepted");
    else add("AssemblyAI key", "fail", `HTTP ${res.status}`);
  } catch (err) {
    add("AssemblyAI key", "fail", err instanceof Error ? err.message : String(err));
  }
}

// Cloud STT/TTS: Rime (one key covers both). Probing Mist v3 validates the key.
const rime = process.env.RIME_API_KEY?.trim();
if (!rime) {
  add("Rime key", "skip", "set RIME_API_KEY to probe (or use Settings → Speech)");
} else {
  try {
    const res = await fetch("https://mist.api.rime.ai/", {
      method: "POST",
      headers: { accept: "audio/wav", authorization: `Bearer ${rime}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) add("Rime key", "fail", "rejected");
    else if (res.ok || res.status === 400 || res.status === 422) add("Rime key", "ok", "accepted (Mist v3 probe)");
    else add("Rime key", "fail", `HTTP ${res.status}`);
  } catch (err) {
    add("Rime key", "fail", err instanceof Error ? err.message : String(err));
  }
}

const icon: Record<State, string> = { ok: "✓", fail: "✗", skip: "–" };
for (const r of results) console.log(`${icon[r.state]} ${r.name}: ${r.detail}`);

const failed = results.filter((r) => r.state === "fail").length;
console.log(failed ? `\n${failed} check(s) failed` : "\nno failures (skips are not failures)");
process.exit(failed ? 1 : 0);
