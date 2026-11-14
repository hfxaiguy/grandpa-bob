/**
 * Settings view — the Solid replacement for the old server-rendered settings
 * page. It talks to the same `/api/*` endpoints through the shared transport
 * shim, so the browser target and the admin-backed host behave identically.
 * No iframe, no inline script scope.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { getJSON, postJSON } from "./api";
import { toast } from "./store";
import { MODEL_PRESETS, presetId } from "./model-presets";
import logoMark from "./assets/logo-mark.webp";
import { buildInfo } from "./build-info";

interface AppEnvField {
  name: string;
  label?: string;
  secret?: boolean;
  description?: string;
  placeholder?: string;
}

interface ServiceStatus {
  name: string;
  up?: boolean | null;
  detail?: string;
}

interface StatusResponse {
  services?: ServiceStatus[];
  telegram?: unknown;
  voice?: unknown;
  llm?: unknown;
  uptime?: number;
  uptimeSec?: number;
  pid?: number | null;
  env?: Record<string, string>;
  appEnv?: AppEnvField[];
}

interface Capabilities {
  admin?: boolean;
  mode?: string;
}

interface EnvRow {
  key: string;
  orig: string;
  value: string;
  removed: boolean;
}

interface ModelThinking {
  reasoning_effort?: unknown;
  think?: unknown;
  options?: unknown;
}

interface ModelEntry {
  baseURL?: string;
  model?: string;
  apiKey?: string;
  protocol?: string;
  transform?: string;
  vision?: boolean;
  thinking?: ModelThinking;
}

type ModelValue = string | ModelEntry;

interface SlotRow {
  id: number;
  name: string;
  alias: string;
  baseURL: string;
  model: string;
  protocol: "" | "ollama";
  vision: boolean;
  apiKey: string;
  transform: "" | "gemma4Thinking";
  reasoning: string;
  think: "" | "true" | "false";
  thinkOptions: string;
  test: { text: string; ok: boolean | null };
}

interface SpeechStt {
  provider?: string;
  language?: string;
  keys?: Record<string, string>;
}

interface SpeechTts {
  provider?: string;
  voice?: string;
  enabled?: boolean;
  autoSpeak?: string | boolean;
  keys?: Record<string, string>;
}

interface SpeechRaw {
  stt?: SpeechStt;
  tts?: SpeechTts;
}

const SPEECH_STORE = "bob:services";

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function readSpeech(): SpeechRaw {
  try {
    const raw = JSON.parse(localStorage.getItem(SPEECH_STORE) || "{}") as SpeechRaw;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function ServerGlyph() {
  return (
    <span class="srv" title="Needs the admin server (BOB_WEB=1)">
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <rect x="1.5" y="1.2" width="9" height="3.7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <rect x="1.5" y="7.1" width="9" height="3.7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <circle cx="3.6" cy="3.05" r=".8" fill="currentColor" />
        <circle cx="3.6" cy="8.95" r=".8" fill="currentColor" />
      </svg>
    </span>
  );
}

function speechAuto(tts: SpeechTts): "off" | "trunk" | "all" {
  if (tts.autoSpeak === "all") return "all";
  if (tts.autoSpeak === "trunk" || tts.autoSpeak === true) return "trunk";
  return "off";
}

export function SettingsView(props: { onChat: () => void; onFiles: () => void }) {
  // ── status / host ────────────────────────────────────────────────────
  const [status, setStatus] = createSignal<StatusResponse | null>(null);
  const [caps, setCaps] = createSignal<Capabilities | null>(null);
  const [follow, setFollow] = createSignal(false);
  const [tick, setTick] = createSignal(Date.now());
  const [uptimeBase, setUptimeBase] = createSignal<number | null>(null);
  const serverAdmin = () => caps()?.admin !== false;

  const services = (): ServiceStatus[] => {
    const s = status();
    if (!s) return [];
    if (Array.isArray(s.services)) return s.services;
    const from = (name: string, value: unknown): ServiceStatus => ({
      name,
      up: value === true ? true : value === false ? false : null,
      detail: typeof value === "string" ? value : undefined,
    });
    return [from("telegram", s.telegram), from("voice", s.voice), from("llm", s.llm)];
  };

  const uptimeText = () => {
    const base = uptimeBase();
    if (base == null) return "";
    const sec = Math.max(0, Math.floor((tick() - base) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `uptime: ${h ? `${h}h ` : ""}${m}m ${s}s`;
  };

  // ── env / credentials ────────────────────────────────────────────────
  const [envRows, setEnvRows] = createStore<{ rows: EnvRow[] }>({ rows: [] });
  const [appEnvValues, setAppEnvValues] = createSignal<Record<string, string>>({});
  const [fToken, setFToken] = createSignal("");
  const [fUid, setFUid] = createSignal("");
  const [fHf, setFHf] = createSignal("");
  const [fOllama, setFOllama] = createSignal("");
  const [fNeuralwatt, setFNeuralwatt] = createSignal("");
  const [fCommandCode, setFCommandCode] = createSignal("");
  const [fExo, setFExo] = createSignal("");

  const envValue = (key: string) => status()?.env?.[key] ?? "";
  const current = (key: string, chars = 6) => {
    const value = envValue(key);
    return value ? `current: ${value.slice(0, chars)}...` : "(unset)";
  };

  function hydrateEnv(env: Record<string, string>): void {
    if (envRows.rows.length) return;
    setEnvRows(
      "rows",
      Object.entries(env).map(([key, value]) => ({ key, orig: key, value: str(value), removed: false })),
    );
  }

  async function refreshStatus(): Promise<StatusResponse> {
    const s = await getJSON<StatusResponse>("/api/status");
    setStatus(s);
    const uptime = typeof s.uptimeSec === "number" ? s.uptimeSec : typeof s.uptime === "number" ? s.uptime : null;
    if (uptime != null) setUptimeBase(Date.now() - uptime * 1000);
    hydrateEnv(s.env ?? {});
    return s;
  }

  async function refreshAll(): Promise<void> {
    try {
      await refreshStatus();
      toast("refreshed");
    } catch (e) {
      toast(e instanceof Error ? e.message : "refresh failed", true);
    }
  }

  async function loadCapabilities(): Promise<void> {
    try {
      const r = await fetch("/api/capabilities");
      setCaps(r.ok ? ((await r.json()) as Capabilities) : { admin: false });
    } catch {
      setCaps({ admin: false });
    }
  }

  async function loadFollow(): Promise<void> {
    try {
      const d = await getJSON<{ follow?: boolean }>("/api/session");
      setFollow(!!d.follow);
    } catch {
      /* keep the default */
    }
  }

  async function setFollowMode(next: boolean): Promise<void> {
    setFollow(next);
    try {
      await postJSON("/api/session", { follow: next });
      toast(next ? "webui follows telegram from now on" : "stopped following telegram");
    } catch {
      setFollow(!next);
    }
  }

  async function restartBot(): Promise<void> {
    if (!serverAdmin()) return;
    try {
      await postJSON("/api/restart-bot");
      toast("bot restarting...");
      setTimeout(() => void refreshStatus().catch(() => {}), 2000);
    } catch {
      /* postJSON already surfaced the error through the throw */
    }
  }

  function addEnvKey(): void {
    setEnvRows("rows", (rows) => [...rows, { key: "", orig: "", value: "", removed: false }]);
  }

  function removeEnvRow(index: number): void {
    setEnvRows("rows", index, "removed", true);
  }

  function envKeyInput(index: number, input: HTMLInputElement): void {
    const value = input.value;
    const eq = value.indexOf("=");
    if (eq > 0) {
      const name = value.slice(0, eq).trim().replace(/^export\s+/i, "");
      if (name) {
        setEnvRows("rows", index, { key: name, value: value.slice(eq + 1).trim() });
        input.value = name;
        return;
      }
    }
    setEnvRows("rows", index, "key", value);
  }

  function collectEnvUpdates(): Record<string, string | null> {
    const updates: Record<string, string | null> = {};
    for (const row of envRows.rows) {
      if (row.removed) {
        if (row.key) updates[row.key] = null;
        continue;
      }
      const key = row.key.trim();
      if (!key) continue;
      if (row.orig && row.orig !== key && !(row.orig in updates)) updates[row.orig] = null;
      updates[key] = row.value;
    }
    return updates;
  }

  function validEnvKey(key: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key);
  }

  async function saveAllEnv(): Promise<void> {
    const updates = collectEnvUpdates();
    if (!Object.keys(updates).length) {
      const rows = envRows.rows.filter((r) => !r.removed);
      if (!rows.length) {
        toast("no keys loaded — press + Add key first", true);
        return;
      }
      if (rows.some((r) => !r.key.trim() && r.value.trim())) {
        toast("put the key name in the left box — rows with a value but no name are skipped", true);
        return;
      }
      if (rows.every((r) => !r.key.trim() && !r.value.trim())) {
        toast("type the key name in the left box and its value on the right", true);
        return;
      }
      toast("nothing to change — edit a value, add a key, or remove one", true);
      return;
    }
    const bad = Object.keys(updates).find((k) => k && !validEnvKey(k));
    if (bad) {
      toast(`invalid key name: ${bad} — use letters, digits, _ . -`, true);
      return;
    }
    try {
      await postJSON("/api/env", updates);
      toast(serverAdmin() ? "saved — restart the bot to apply" : "saved to this browser profile — applies immediately");
      setEnvRows("rows", []);
      await refreshStatus();
    } catch (e) {
      toast(e instanceof Error ? e.message : "save failed", true);
    }
  }

  async function saveEnv(e: Event): Promise<void> {
    e.preventDefault();
    const body: Record<string, string> = {};
    if (fToken().trim()) body.TELEGRAM_BOT_TOKEN = fToken().trim();
    if (fUid().trim()) body.ALLOWED_USER_IDS = fUid().trim();
    if (fHf().trim()) body.LLM_API_KEY = fHf().trim();
    if (fOllama().trim()) body.OLLAMA_API_KEY = fOllama().trim();
    if (fNeuralwatt().trim()) body.NEURALWATT_API_KEY = fNeuralwatt().trim();
    if (fCommandCode().trim()) body.COMMAND_CODE_API_KEY = fCommandCode().trim();
    if (fExo().trim()) body.EXO_API_KEY = fExo().trim();
    const appValues = appEnvValues();
    for (const field of status()?.appEnv ?? []) {
      const value = (appValues[field.name] ?? "").trim();
      if (value) body[field.name] = value;
    }
    if (!Object.keys(body).length) {
      toast("nothing to save", true);
      return;
    }
    try {
      await postJSON("/api/env", body);
      toast("saved");
      setFToken("");
      setFUid("");
      setFHf("");
      setFOllama("");
      setFNeuralwatt("");
      setFCommandCode("");
      setFExo("");
      setAppEnvValues({});
      await refreshStatus();
    } catch (e) {
      toast(e instanceof Error ? e.message : "save failed", true);
    }
  }

  // ── speech ───────────────────────────────────────────────────────────
  const [savedSpeech, setSavedSpeech] = createSignal<SpeechRaw>(readSpeech());
  const [sttProvider, setSttProvider] = createSignal("");
  const [sttLanguage, setSttLanguage] = createSignal("");
  const [sttKey, setSttKey] = createSignal("");
  const [ttsProvider, setTtsProvider] = createSignal("");
  const [ttsVoice, setTtsVoice] = createSignal("");
  const [ttsEnabled, setTtsEnabled] = createSignal(true);
  const [ttsAuto, setTtsAuto] = createSignal<"off" | "trunk" | "all">("off");
  const [ttsKey, setTtsKey] = createSignal("");
  const [speechStatus, setSpeechStatus] = createSignal("");

  function loadSpeechForm(): void {
    const raw = readSpeech();
    setSavedSpeech(raw);
    const stt = raw.stt ?? {};
    const tts = raw.tts ?? {};
    setSttProvider(stt.provider ?? "");
    setSttLanguage(stt.language ?? "");
    setTtsProvider(tts.provider ?? "");
    setTtsVoice(tts.voice ?? "");
    setTtsEnabled(tts.enabled !== false);
    setTtsAuto(speechAuto(tts));
  }

  const sttKeySaved = () => {
    const stt = savedSpeech().stt ?? {};
    return stt.provider && stt.keys?.[stt.provider] ? "saved" : "";
  };
  const ttsKeySaved = () => {
    const tts = savedSpeech().tts ?? {};
    return tts.provider && tts.keys?.[tts.provider] ? "saved" : "";
  };

  function saveSpeech(): void {
    try {
      const raw = readSpeech();
      const provider = sttProvider();
      const stt: SpeechStt = { ...(raw.stt ?? {}) };
      stt.provider = provider;
      stt.language = sttLanguage().trim();
      const key = sttKey().trim();
      if (key && provider) {
        stt.keys = { ...(stt.keys ?? {}) };
        stt.keys[provider] = key;
      }
      raw.stt = stt;
      const tts: SpeechTts = { ...(raw.tts ?? {}) };
      tts.provider = ttsProvider();
      tts.voice = ttsVoice().trim();
      if (ttsEnabled()) delete tts.enabled;
      else tts.enabled = false;
      if (ttsAuto() === "off") delete tts.autoSpeak;
      else tts.autoSpeak = ttsAuto();
      const ttsKeyValue = ttsKey().trim();
      if (ttsKeyValue && tts.provider) {
        tts.keys = { ...(tts.keys ?? {}) };
        tts.keys[tts.provider] = ttsKeyValue;
      }
      raw.tts = tts;
      localStorage.setItem(SPEECH_STORE, JSON.stringify(raw));
      setSttKey("");
      setTtsKey("");
      loadSpeechForm();
      toast("speech settings saved");
    } catch {
      toast("could not save speech settings", true);
    }
  }

  async function testSpeech(): Promise<void> {
    const provider = sttProvider();
    if (provider === "rime") {
      setSpeechStatus("Rime keys are verified by the desktop on first use");
      return;
    }
    if (provider !== "assemblyai") {
      setSpeechStatus("local providers run on the paired desktop — record a clip to test");
      return;
    }
    const key = sttKey().trim() || (savedSpeech().stt?.keys?.assemblyai ?? "");
    if (!key) {
      setSpeechStatus("add a key first");
      return;
    }
    setSpeechStatus("testing…");
    try {
      const r = await fetch("https://sync.assemblyai.com/v1/transcribe", {
        method: "POST",
        headers: { authorization: key, "x-aai-model": "universal-3-5-pro" },
        body: new FormData(),
      });
      if (r.status === 404) setSpeechStatus("key rejected");
      else if (r.ok || r.status === 400 || r.status === 422) setSpeechStatus("key accepted");
      else setSpeechStatus(`HTTP ${r.status}`);
    } catch {
      setSpeechStatus("unreachable");
    }
  }

  // ── models ───────────────────────────────────────────────────────────
  let slotSeq = 0;
  const [slots, setSlots] = createStore<{ rows: SlotRow[] }>({ rows: [] });
  const [rawOpen, setRawOpen] = createSignal(false);
  const [rawText, setRawText] = createSignal("");
  const [modelOptions, setModelOptions] = createSignal<string[]>([]);

  function makeSlotRow(name: string, value: ModelValue | undefined, id: number): SlotRow {
    const entry: ModelEntry = typeof value === "string" || !value ? {} : value;
    const thinking = entry.thinking && typeof entry.thinking === "object" ? entry.thinking : {};
    const options = thinking.options;
    const think = thinking.think === true ? "true" : thinking.think === false ? "false" : "";
    return {
      id,
      name,
      alias: typeof value === "string" ? value : "",
      baseURL: str(entry.baseURL),
      model: str(entry.model),
      protocol: entry.protocol === "ollama" ? "ollama" : "",
      vision: entry.vision === true,
      apiKey: str(entry.apiKey),
      transform: entry.transform === "gemma4Thinking" ? "gemma4Thinking" : "",
      reasoning: thinking.reasoning_effort == null ? "" : str(thinking.reasoning_effort),
      think,
      thinkOptions: options && typeof options === "object" ? JSON.stringify(options) : "",
      test: { text: "", ok: null },
    };
  }

  function rowsFromRegistry(registry: Record<string, ModelValue>): SlotRow[] {
    return Object.entries(registry).map(([name, value]) => makeSlotRow(name, value, ++slotSeq));
  }

  function readSlot(row: SlotRow): ModelValue {
    const alias = row.alias.trim();
    if (alias) return alias;
    const entry: ModelEntry = {};
    const baseURL = row.baseURL.trim();
    if (baseURL) entry.baseURL = baseURL;
    const model = row.model.trim();
    if (model) entry.model = model;
    const apiKey = row.apiKey.trim();
    if (apiKey) entry.apiKey = apiKey;
    if (row.protocol) entry.protocol = row.protocol;
    if (row.transform) entry.transform = row.transform;
    if (row.vision) entry.vision = true;
    const thinking: ModelThinking = {};
    const reasoning = row.reasoning.trim();
    if (reasoning) thinking.reasoning_effort = reasoning;
    if (row.think === "true") thinking.think = true;
    else if (row.think === "false") thinking.think = false;
    const options = row.thinkOptions.trim();
    if (options) {
      try {
        const parsed = JSON.parse(options) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) thinking.options = parsed;
      } catch {
        /* invalid JSON is ignored while typing */
      }
    }
    if (Object.keys(thinking).length) entry.thinking = thinking;
    return entry;
  }

  function buildRegistry(): Record<string, ModelValue> {
    const out: Record<string, ModelValue> = {};
    for (const row of slots.rows) {
      const name = row.name.trim();
      if (name) out[name] = readSlot(row);
    }
    return out;
  }

  function syncRawText(): void {
    setRawText(JSON.stringify(buildRegistry(), null, 2));
  }

  async function loadModels(): Promise<void> {
    try {
      const d = await getJSON<{ json?: string }>("/api/models");
      const text = d.json ?? "";
      setRawText(text);
      try {
        const parsed = text ? (JSON.parse(text) as unknown) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("models.json must be an object of name → entry");
        }
        setSlots("rows", rowsFromRegistry(parsed as Record<string, ModelValue>));
      } catch (e) {
        setSlots("rows", []);
        setRawOpen(true);
        toast(`models.json is not valid JSON — fix it in Raw JSON (${e instanceof Error ? e.message : "parse error"})`, true);
      }
    } catch {
      /* optional endpoint — leave the form empty */
    }
  }

  function toggleRaw(): void {
    if (rawOpen()) {
      try {
        const parsed = JSON.parse(rawText() || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("top-level value must be an object");
        }
        setSlots("rows", rowsFromRegistry(parsed as Record<string, ModelValue>));
        setRawOpen(false);
      } catch (e) {
        toast(`invalid JSON: ${e instanceof Error ? e.message : "parse error"}`, true);
      }
    } else {
      syncRawText();
      setRawOpen(true);
    }
  }

  function addSlot(): void {
    const registry = buildRegistry();
    let n = 1;
    while (registry[`model${n}`]) n += 1;
    const id = ++slotSeq;
    setRawOpen(false);
    setSlots("rows", (rows) => [...rows, makeSlotRow(`model${n}`, undefined, id)]);
    syncRawText();
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(
        `.admin-page [data-slot-id="${id}"] .ms-name`,
      );
      input?.focus();
      input?.select();
    }, 0);
  }

  function removeSlot(index: number): void {
    setSlots("rows", (rows) => rows.filter((_, i) => i !== index));
    syncRawText();
  }

  function updatePreset(index: number, id: string): void {
    const preset = MODEL_PRESETS[id];
    if (!preset || id === "custom") return;
    setSlots("rows", index, { baseURL: preset.baseURL, protocol: preset.protocol ?? "" });
  }

  async function testSlot(index: number): Promise<void> {
    const value = readSlot(slots.rows[index]);
    const target = typeof value === "string" ? buildRegistry()[value] : value;
    if (!target || typeof target !== "object") {
      setSlots("rows", index, "test", {
        text: typeof value === "string" ? `alias "${value}" has no slot` : "no model fields",
        ok: false,
      });
      return;
    }
    if (!Object.keys(target).length) {
      setSlots("rows", index, "test", { text: "no model fields", ok: false });
      return;
    }
    setSlots("rows", index, "test", { text: "testing...", ok: null });
    try {
      const d = await postJSON<{ ok?: boolean; models?: string[]; error?: string }>("/api/models/test", target);
      const models = Array.isArray(d.models) ? d.models : [];
      if (models.length) {
        const merged = new Set(modelOptions());
        for (const model of models) merged.add(model);
        setModelOptions([...merged]);
      }
      const count = models.length ? ` - ${models.length} model(s)` : "";
      const text = d.ok ? `reachable${count}` : `unreachable${count}`;
      setSlots("rows", index, "test", { text: d.error ? `${text}: ${d.error}` : text, ok: !!d.ok });
    } catch (e) {
      setSlots("rows", index, "test", {
        text: e instanceof Error ? e.message : "test failed",
        ok: false,
      });
    }
  }

  async function saveModels(): Promise<void> {
    let text: string;
    if (rawOpen()) text = rawText();
    else {
      text = JSON.stringify(buildRegistry(), null, 2);
      setRawText(text);
    }
    try {
      const d = await postJSON<{ reachable?: Record<string, boolean> }>("/api/models", { json: text });
      const parsed = text ? (JSON.parse(text) as unknown) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setSlots("rows", rowsFromRegistry(parsed as Record<string, ModelValue>));
      }
      const names = Object.keys(d.reachable ?? {});
      const bad = names.filter((n) => !d.reachable?.[n]);
      toast(
        bad.length
          ? `saved - unreachable: ${bad.join(", ")}`
          : `models saved and applied${names.length ? ` (${names.length} slot(s))` : ""}`,
        bad.length > 0,
      );
    } catch (e) {
      toast(`models save failed: ${e instanceof Error ? e.message : "unknown error"}`, true);
    }
  }

  async function claimFreeKey(): Promise<void> {
    try {
      const d = await postJSON<{
        json?: string;
        tokensRemaining?: number;
        requestsRemaining?: number;
        expiresAt?: string;
      }>("/api/ai/claim");
      if (d.json) setRawText(d.json);
      await loadModels();
      const parts: string[] = [];
      if (typeof d.tokensRemaining === "number") parts.push(`${d.tokensRemaining.toLocaleString()} tokens`);
      if (typeof d.requestsRemaining === "number") parts.push(`${d.requestsRemaining} requests`);
      const until = d.expiresAt ? ` until ${new Date(d.expiresAt).toLocaleString()}` : "";
      toast(`free BobSwap key claimed${parts.length ? ` - ${parts.join(" / ")}${until}` : ""}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "claim failed", true);
    }
  }

  // ── logs ─────────────────────────────────────────────────────────────
  const [logText, setLogText] = createSignal("");
  const [logName, setLogName] = createSignal("");

  async function loadLog(name: string): Promise<void> {
    if (!serverAdmin()) return;
    try {
      const r = await getJSON<{ content?: string }>(`/api/log?file=${encodeURIComponent(name)}`);
      setLogName(name);
      setLogText(r.content || "(empty)");
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not load log", true);
    }
  }

  onMount(() => {
    let disposed = false;
    void loadCapabilities();
    void refreshStatus().catch(() => {});
    void loadFollow();
    void loadModels();
    loadSpeechForm();
    const tickTimer = setInterval(() => setTick(Date.now()), 1000);
    const statusTimer = setInterval(() => {
      if (document.hidden) return;
      if (!disposed) void refreshStatus().catch(() => {});
    }, 10000);
    onCleanup(() => {
      disposed = true;
      clearInterval(tickTimer);
      clearInterval(statusTimer);
    });
  });

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">
          <img class="brand-mark" src={logoMark} alt="" aria-hidden="true" />
        </span>
        <span class="admin-title">settings</span>
        <span class="spacer" />
        <nav class="admin-nav">
          <button type="button" class="link-btn" onClick={props.onFiles}>
            files
          </button>
          <button type="button" class="link-btn" onClick={props.onChat}>
            ← chat
          </button>
        </nav>
        <span class="build-stamp" title={buildInfo.title}>
          {buildInfo.label}
        </span>
      </header>

      <div class="admin-page">
        <section class="admin-card">
          <div class="row">
            <span class="services">
              <For each={services()}>
                {(svc) => (
                  <span class="status" title={svc.detail ?? ""}>
                    <span class={`dot ${svc.up === true ? "on" : svc.up === false ? "off" : "na"}`} />
                    {svc.name}
                  </span>
                )}
              </For>
            </span>
            <span class="status">
              <span class={`dot ${caps() == null ? "na" : serverAdmin() ? "on" : "off"}`} />
              {caps() == null ? "checking server…" : serverAdmin() ? "admin (this)" : "browser only"}
            </span>
            <span class="uptime">{uptimeText()}</span>
          </div>
          <div class="row" style={{ "margin-top": "8px" }}>
            <label class="status" title="The webui automatically continues whichever conversation is live on Telegram. Telegram never picks up web chats.">
              <input
                type="checkbox"
                checked={follow()}
                disabled={!serverAdmin()}
                onChange={(e) => void setFollowMode(e.currentTarget.checked)}
                style={{ "margin-right": "6px" }}
              />
              webui follows telegram <ServerGlyph />
            </label>
            <small class="muted">one-way: telegram never follows the webui</small>
          </div>
          <Show when={!serverAdmin()}>
            <div class="server-note">
              No admin server (BOB_WEB=1) — the Telegram bridge, service health, bot logs and restart are
              unavailable. Everything below applies to this browser workspace.
            </div>
          </Show>
          <div class="actions">
            <button id="restart-btn" type="button" disabled={!serverAdmin()} onClick={() => void restartBot()}>
              Restart bot <ServerGlyph />
            </button>
            <button class="secondary" type="button" onClick={() => void refreshAll()}>
              Refresh
            </button>
          </div>
        </section>

        <section class="admin-card">
          <h2>Credentials &amp; .env</h2>
          <form onSubmit={(e) => void saveEnv(e)}>
            <div class="grid-2">
              <div>
                <label>
                  Telegram bot token <span class="muted">{current("TELEGRAM_BOT_TOKEN", 8)}</span>
                </label>
                <input
                  type="password"
                  placeholder="123456:ABC-DEF..."
                  value={fToken()}
                  onInput={(e) => setFToken(e.currentTarget.value)}
                />
              </div>
              <div>
                <label>
                  Your Telegram user ID <span class="muted">{envValue("ALLOWED_USER_IDS") ? `current: ${envValue("ALLOWED_USER_IDS")}` : "(unset)"}</span>
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="123456789"
                  value={fUid()}
                  onInput={(e) => setFUid(e.currentTarget.value)}
                />
              </div>
            </div>
            <label>
              Hugging Face API key <span class="muted">{current("LLM_API_KEY")}</span>
            </label>
            <input
              type="password"
              placeholder="hf_..."
              value={fHf()}
              onInput={(e) => setFHf(e.currentTarget.value)}
            />
            <label>
              Ollama API key <span class="muted">{current("OLLAMA_API_KEY")}</span>
            </label>
            <input
              type="password"
              placeholder="ollama-api-key..."
              value={fOllama()}
              onInput={(e) => setFOllama(e.currentTarget.value)}
            />
            <label>
              Neuralwatt API key <span class="muted">{current("NEURALWATT_API_KEY")}</span>
            </label>
            <input
              type="password"
              placeholder="sk-..."
              value={fNeuralwatt()}
              onInput={(e) => setFNeuralwatt(e.currentTarget.value)}
            />
            <label>
              CommandCode API key <span class="muted">{current("COMMAND_CODE_API_KEY")}</span>
            </label>
            <input
              type="password"
              placeholder="user_... (Provider API key from Command Code Studio)"
              value={fCommandCode()}
              onInput={(e) => setFCommandCode(e.currentTarget.value)}
            />
            <label>
              Exa search API key <span class="muted">{current("EXO_API_KEY")}</span>
            </label>
            <input
              type="password"
              placeholder="exa-... (used by exa_search)"
              value={fExo()}
              onInput={(e) => setFExo(e.currentTarget.value)}
            />
            <For each={status()?.appEnv ?? []}>
              {(field) => (
                <div>
                  <label>
                    {field.label || field.name}
                    <code style={{ "margin-left": "8px", "font-size": "11px" }}>{field.name}</code>
                    <span class="muted" style={{ float: "right" }}>
                      {envValue(field.name)
                        ? `current: ${field.secret ? `${envValue(field.name).slice(0, 6)}...` : envValue(field.name)}`
                        : "(unset)"}
                    </span>
                  </label>
                  <input
                    type={field.secret ? "password" : "text"}
                    placeholder={field.placeholder || field.name}
                    value={appEnvValues()[field.name] ?? ""}
                    onInput={(e) =>
                      setAppEnvValues((values) => ({ ...values, [field.name]: e.currentTarget.value }))
                    }
                    autocomplete="off"
                    spellcheck={false}
                  />
                  <Show when={field.description}>
                    <small>{field.description}</small>
                  </Show>
                </div>
              )}
            </For>
            <small>Shortcuts for the most common keys — every other key in <code>.env</code> is editable below.</small>
            <div class="actions">
              <button type="submit">Save credentials</button>
            </div>
          </form>
          <div style={{ margin: "16px 0", "border-top": "1px solid var(--border)" }} />
          <h3>All .env keys</h3>
          <p>
            <small>
              Values visible. Edit a value, rename a key, add or remove keys. Changes apply after a bot restart.
            </small>
          </p>
          <div>
            <For each={envRows.rows}>
              {(row, index) => (
                <Show when={!row.removed}>
                  <div style={{ "margin-bottom": "10px" }}>
                    <label style={{ "margin-top": "0" }}>
                      <input
                        class="env-key"
                        value={row.key}
                        placeholder="KEY NAME"
                        spellcheck={false}
                        onInput={(e) => envKeyInput(index(), e.currentTarget)}
                        style={{ width: "auto", "min-width": "120px", "margin-right": "8px" }}
                      />
                      <button
                        class="secondary"
                        type="button"
                        title="Remove this key"
                        style={{ float: "right", padding: "2px 10px" }}
                        onClick={() => removeEnvRow(index())}
                      >
                        ×
                      </button>
                    </label>
                    <input
                      class="env-val"
                      value={row.value}
                      placeholder="value"
                      onInput={(e) => setEnvRows("rows", index(), "value", e.currentTarget.value)}
                    />
                  </div>
                </Show>
              )}
            </For>
            <Show when={!envRows.rows.filter((r) => !r.removed).length}>
              <div class="muted">(no keys — add one below)</div>
            </Show>
          </div>
          <div class="actions">
            <button class="secondary" type="button" onClick={addEnvKey}>
              + Add key
            </button>
            <button type="button" onClick={() => void saveAllEnv()}>
              Save all keys
            </button>
          </div>
        </section>

        <section class="admin-card">
          <h2>Speech</h2>
          <p>
            <small>
              Which transcriber the mic button uses. Local providers run on the paired desktop. AssemblyAI is
              called straight from this browser with the key below — the key stays in this browser and is never
              sent to the desktop or to seed/relay transfers.
            </small>
          </p>
          <div class="grid-2">
            <div>
              <label>STT provider</label>
              <select value={sttProvider()} onChange={(e) => setSttProvider(e.currentTarget.value)}>
                <option value="">Desktop default (.env)</option>
                <option value="whisper">Whisper (local server)</option>
                <option value="sherpa">Sherpa (local server)</option>
                <option value="parakeet">Parakeet (local server)</option>
                <option value="assemblyai">AssemblyAI (cloud, in-tab)</option>
                <option value="rime">Rime STT (cloud, via desktop)</option>
              </select>
            </div>
            <div>
              <label>STT language</label>
              <input
                type="text"
                placeholder="blank = provider default (rime: en/es)"
                value={sttLanguage()}
                onInput={(e) => setSttLanguage(e.currentTarget.value)}
              />
            </div>
          </div>
          <label>
            Cloud STT key <span class="muted">{sttKeySaved()}</span>
          </label>
          <input
            type="password"
            placeholder="paste the key for the chosen cloud provider (blank keeps the saved one)"
            value={sttKey()}
            onInput={(e) => setSttKey(e.currentTarget.value)}
          />
          <label style={{ display: "flex", gap: "8px", "align-items": "center", "margin-top": "12px" }}>
            <input
              type="checkbox"
              checked={ttsEnabled()}
              onChange={(e) => setTtsEnabled(e.currentTarget.checked)}
            />
            Enable text-to-speech (🔊 buttons and auto-speak)
          </label>
          <div class="grid-2" style={{ "margin-top": "8px" }}>
            <div>
              <label>TTS provider</label>
              <select value={ttsProvider()} onChange={(e) => setTtsProvider(e.currentTarget.value)}>
                <option value="">Desktop default (.env)</option>
                <option value="kitten">KittenTTS (local server)</option>
                <option value="rime">Rime Mist v3 (cloud, via desktop)</option>
              </select>
            </div>
            <div>
              <label>TTS voice</label>
              <input
                type="text"
                list="speech-tts-voices"
                placeholder="Bella (kitten) / cove (rime)"
                value={ttsVoice()}
                onInput={(e) => setTtsVoice(e.currentTarget.value)}
              />
              <datalist id="speech-tts-voices">
                <option value="Bella" />
                <option value="Jasper" />
                <option value="Luna" />
                <option value="Bruno" />
                <option value="Rosie" />
                <option value="Hugo" />
                <option value="Kiki" />
                <option value="Leo" />
              </datalist>
            </div>
          </div>
          <label style={{ "margin-top": "12px" }}>Speak new replies automatically</label>
          <div class="radio-row" role="radiogroup" aria-label="Speak new replies automatically">
            <label class="radio">
              <input
                type="radio"
                name="speech-tts-auto"
                value="off"
                checked={ttsAuto() === "off"}
                onChange={() => setTtsAuto("off")}
              />
              Off
            </label>
            <label class="radio">
              <input
                type="radio"
                name="speech-tts-auto"
                value="trunk"
                checked={ttsAuto() === "trunk"}
                onChange={() => setTtsAuto("trunk")}
              />
              Trunk only
            </label>
            <label class="radio">
              <input
                type="radio"
                name="speech-tts-auto"
                value="all"
                checked={ttsAuto() === "all"}
                onChange={() => setTtsAuto("all")}
              />
              All apps
            </label>
          </div>
          <label>
            Cloud TTS key <span class="muted">{ttsKeySaved()}</span>
          </label>
          <input
            type="password"
            placeholder="Rime key (blank keeps the saved one)"
            value={ttsKey()}
            onInput={(e) => setTtsKey(e.currentTarget.value)}
          />
          <div class="actions">
            <button type="button" onClick={saveSpeech}>
              Save speech settings
            </button>
            <button class="secondary" type="button" onClick={() => void testSpeech()}>
              Test
            </button>
            <span class="muted">{speechStatus()}</span>
          </div>
        </section>

        <section class="admin-card">
          <h2>Models</h2>
          <p>
            <small>
              Named model slots the trees reference (<code>Model("strong")</code>, <code>Model("cheap")</code>).
              Each slot points at any OpenAI-compatible endpoint (Ollama local/cloud, OpenAI, Neuralwatt,
              CommandCode, OpenRouter, llama.cpp…) or native Ollama. Pick a provider preset, choose a model, then{" "}
              <b>Test</b>. Tick <b>vision</b> only when the model accepts image inputs — trees read it from{" "}
              <code>model_catalog</code>. Saving applies immediately — no restart. Keys may use{" "}
              <code>${"{ENV}"}</code> to reference the credentials above, or be pasted literally.
            </small>
          </p>
          <Show
            when={rawOpen()}
            fallback={
              <div>
                <For each={slots.rows}>
                  {(row, index) => {
                    const aliasOn = () => !!row.alias.trim();
                    return (
                      <div class="slot-card" data-slot-id={row.id}>
                        <div class="row">
                          <label class="grow" style={{ "margin-top": "0" }}>
                            slot
                            <input
                              class="ms-name"
                              type="text"
                              value={row.name}
                              onInput={(e) => setSlots("rows", index(), "name", e.currentTarget.value)}
                            />
                          </label>
                          <label class="grow-2" style={{ "margin-top": "0" }}>
                            provider
                            <select
                              class="ms-preset"
                              value={presetId(row.baseURL, row.protocol)}
                              disabled={aliasOn()}
                              onChange={(e) => updatePreset(index(), e.currentTarget.value)}
                            >
                              <For each={Object.entries(MODEL_PRESETS)}>
                                {(entry) => <option value={entry[0]}>{entry[1].label}</option>}
                              </For>
                            </select>
                          </label>
                          <button
                            class="secondary"
                            type="button"
                            style={{ "align-self": "flex-end" }}
                            onClick={() => removeSlot(index())}
                          >
                            remove
                          </button>
                        </div>
                        <label>
                          alias of
                          <input
                            type="text"
                            value={row.alias}
                            placeholder="another slot name (optional - this slot becomes a pointer)"
                            onInput={(e) => setSlots("rows", index(), "alias", e.currentTarget.value)}
                          />
                        </label>
                        <label>
                          base URL
                          <input
                            type="text"
                            value={row.baseURL}
                            disabled={aliasOn()}
                            placeholder="https://api.neuralwatt.com/v1"
                            onInput={(e) => setSlots("rows", index(), "baseURL", e.currentTarget.value)}
                          />
                        </label>
                        <div class="row">
                          <label class="grow-2" style={{ "margin-top": "0" }}>
                            model
                            <input
                              type="text"
                              list="models-datalist"
                              value={row.model}
                              disabled={aliasOn()}
                              placeholder="model id"
                              onInput={(e) => setSlots("rows", index(), "model", e.currentTarget.value)}
                            />
                          </label>
                          <label class="grow" style={{ "margin-top": "0" }}>
                            protocol
                            <select
                              value={row.protocol}
                              disabled={aliasOn()}
                              onChange={(e) =>
                                setSlots(
                                  "rows",
                                  index(),
                                  "protocol",
                                  e.currentTarget.value === "ollama" ? "ollama" : "",
                                )
                              }
                            >
                              <option value="">OpenAI-compatible</option>
                              <option value="ollama">Ollama native</option>
                            </select>
                          </label>
                          <label
                            class="status"
                            style={{ "margin-top": "0", display: "flex", gap: "6px", "align-items": "center" }}
                          >
                            vision
                            <input
                              type="checkbox"
                              checked={row.vision}
                              disabled={aliasOn()}
                              onChange={(e) => setSlots("rows", index(), "vision", e.currentTarget.checked)}
                            />
                          </label>
                        </div>
                        <label>
                          API key
                          <input
                            type="text"
                            value={row.apiKey}
                            disabled={aliasOn()}
                            placeholder="${ENV_VAR} or literal key"
                            onInput={(e) => setSlots("rows", index(), "apiKey", e.currentTarget.value)}
                          />
                        </label>
                        <div class="row">
                          <label class="grow" style={{ "margin-top": "0" }}>
                            transform
                            <select
                              value={row.transform}
                              disabled={aliasOn()}
                              onChange={(e) =>
                                setSlots(
                                  "rows",
                                  index(),
                                  "transform",
                                  e.currentTarget.value === "gemma4Thinking" ? "gemma4Thinking" : "",
                                )
                              }
                            >
                              <option value="">none</option>
                              <option value="gemma4Thinking">gemma4Thinking</option>
                            </select>
                          </label>
                          <button
                            class="secondary"
                            type="button"
                            style={{ "align-self": "flex-end" }}
                            onClick={() => void testSlot(index())}
                          >
                            Test
                          </button>
                          <span
                            class={`slot-test-status ${
                              row.test.ok === true ? "ok" : row.test.ok === false ? "err" : ""
                            }`}
                          >
                            {row.test.text}
                          </span>
                        </div>
                        <div class="row">
                          <label class="grow" style={{ "margin-top": "0" }}>
                            thinking: reasoning_effort
                            <input
                              type="text"
                              value={row.reasoning}
                              disabled={aliasOn()}
                              placeholder="low / medium / high"
                              onInput={(e) => setSlots("rows", index(), "reasoning", e.currentTarget.value)}
                            />
                          </label>
                          <label class="grow" style={{ "margin-top": "0" }}>
                            Ollama think
                            <select
                              value={row.think}
                              disabled={aliasOn()}
                              onChange={(e) =>
                                setSlots(
                                  "rows",
                                  index(),
                                  "think",
                                  e.currentTarget.value === "true"
                                    ? "true"
                                    : e.currentTarget.value === "false"
                                      ? "false"
                                      : "",
                                )
                              }
                            >
                              <option value="">default</option>
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          </label>
                          <label class="grow-2" style={{ "margin-top": "0" }}>
                            thinking: options JSON
                            <input
                              type="text"
                              value={row.thinkOptions}
                              disabled={aliasOn()}
                              placeholder="optional JSON, e.g. num_ctx"
                              onInput={(e) => setSlots("rows", index(), "thinkOptions", e.currentTarget.value)}
                            />
                          </label>
                        </div>
                      </div>
                    );
                  }}
                </For>
                <Show when={!slots.rows.length}>
                  <p>
                    <small>(no model slots yet - add one)</small>
                  </p>
                </Show>
              </div>
            }
          >
            <textarea
              rows={9}
              style={{ width: "100%", font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace" }}
              placeholder='{"strong":{"baseURL":"https://api.neuralwatt.com/v1","apiKey":"${NEURALWATT_API_KEY}","model":"glm-5.3"}}'
              value={rawText()}
              onInput={(e) => setRawText(e.currentTarget.value)}
            />
            <p>
              <small>
                Raw registry JSON — the exact file that is saved. Edits here are honored on save; otherwise the
                form above builds it.
              </small>
            </p>
          </Show>
          <datalist id="models-datalist">
            <For each={modelOptions()}>{(model) => <option value={model} />}</For>
          </datalist>
          <div class="actions">
            <button class="secondary" type="button" onClick={addSlot}>
              + Add model
            </button>
            <button type="button" onClick={() => void saveModels()}>
              Save models
            </button>
            <button
              class="secondary"
              type="button"
              title="Claim BobSwap's free temporary key and point the v4/v4.1 slots at its proxy"
              onClick={() => void claimFreeKey()}
            >
              Claim free key
            </button>
            <button class="secondary" type="button" onClick={toggleRaw}>
              Raw JSON
            </button>
          </div>
        </section>

        <section class="admin-card">
          <h2>Logs</h2>
          <div class="row" style={{ "margin-bottom": "8px" }}>
            <button
              class="secondary"
              type="button"
              disabled={!serverAdmin()}
              onClick={() => void loadLog("bot")}
            >
              bot.log <ServerGlyph />
            </button>
            <button
              class="secondary"
              type="button"
              disabled={!serverAdmin()}
              onClick={() => void loadLog("sherpa")}
            >
              sherpa.log <ServerGlyph />
            </button>
            <small class="muted" style={{ "margin-left": "auto" }}>
              {logName() || "last 60 lines"}
            </small>
          </div>
          <pre>{logText() || "(click a log button)"}</pre>
        </section>

        <section class="admin-card">
          <h2>Access</h2>
          <p>
            <small>
              This UI is served from <code>{location.origin}</code>.
            </small>
          </p>
          <p>
            <small>If you're on the same Wi-Fi, open this address from another device.</small>
          </p>
          <p>
            <small>To expose it to the internet, run an SSH reverse tunnel or use Termux's cloudflared.</small>
          </p>
        </section>
      </div>
    </div>
  );
}
