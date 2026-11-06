import { STT_PROVIDER_META, TTS_PROVIDER_META } from "./registry";

/**
 * Browser-global speech config (`bob:services`), shared by the chat UI and the
 * Settings page on the same origin. It is a plain localStorage key by design:
 * the config applies immediately, nothing is mirrored to the desktop, and keys
 * never enter relay/seed publish paths.
 */
export const SERVICES_KEY = "bob:services";

export interface SttServiceConfig {
  /** "" = let the desktop use its configured backend (`.env`). */
  provider: string;
  language?: string;
  /** Provider id → API key. Keys stay in this browser. */
  keys?: Record<string, string>;
}

export interface TtsServiceConfig {
  /** "" = let the desktop use its configured provider (`TTS_PROVIDER`). */
  provider: string;
  voice?: string;
  /** Speak each new trunk reply automatically. */
  autoSpeak?: boolean;
  /** Provider id → API key. Keys stay in this browser. */
  keys?: Record<string, string>;
}

export interface ServicesConfig {
  stt: SttServiceConfig;
  tts: TtsServiceConfig;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function normalizeStt(raw: unknown): SttServiceConfig {
  const stt = (raw && typeof raw === "object" ? raw : {}) as Partial<SttServiceConfig>;
  const provider =
    typeof stt.provider === "string" && STT_PROVIDER_META.some((p) => p.id === stt.provider)
      ? stt.provider
      : "";
  const out: SttServiceConfig = { provider };
  if (typeof stt.language === "string" && stt.language.trim()) out.language = stt.language.trim();
  if (stt.keys && typeof stt.keys === "object") {
    const keys: Record<string, string> = {};
    for (const [id, value] of Object.entries(stt.keys)) {
      if (typeof value === "string" && value.trim()) keys[id] = value.trim();
    }
    if (Object.keys(keys).length) out.keys = keys;
  }
  return out;
}

/** The key the selected provider should use. */
export function sttKeyFor(config: SttServiceConfig, provider = config.provider): string | undefined {
  return provider ? config.keys?.[provider] : undefined;
}

function normalizeTts(raw: unknown): TtsServiceConfig {
  const tts = (raw && typeof raw === "object" ? raw : {}) as Partial<TtsServiceConfig>;
  const provider =
    typeof tts.provider === "string" && TTS_PROVIDER_META.some((p) => p.id === tts.provider)
      ? tts.provider
      : "";
  const out: TtsServiceConfig = { provider };
  if (typeof tts.voice === "string" && tts.voice.trim()) out.voice = tts.voice.trim();
  if (tts.autoSpeak === true) out.autoSpeak = true;
  if (tts.keys && typeof tts.keys === "object") {
    const keys: Record<string, string> = {};
    for (const [id, value] of Object.entries(tts.keys)) {
      if (typeof value === "string" && value.trim()) keys[id] = value.trim();
    }
    if (Object.keys(keys).length) out.keys = keys;
  }
  return out;
}

/** The key the selected TTS provider should use. */
export function ttsKeyFor(config: TtsServiceConfig, provider = config.provider): string | undefined {
  return provider ? config.keys?.[provider] : undefined;
}

/** true when the selected TTS provider is a cloud service. */
export function isCloudTtsProvider(id: string): boolean {
  return TTS_PROVIDER_META.some((p) => p.id === id && p.cloud);
}

export function loadServices(store: StorageLike | null = defaultStorage()): ServicesConfig {
  const empty: ServicesConfig = { stt: { provider: "" }, tts: { provider: "" } };
  if (!store) return empty;
  try {
    const parsed = JSON.parse(store.getItem(SERVICES_KEY) ?? "{}") as {
      stt?: unknown;
      tts?: unknown;
    };
    return { stt: normalizeStt(parsed.stt), tts: normalizeTts(parsed.tts) };
  } catch {
    return empty;
  }
}

export function loadSttConfig(store: StorageLike | null = defaultStorage()): SttServiceConfig {
  return loadServices(store).stt;
}

export function loadTtsConfig(store: StorageLike | null = defaultStorage()): TtsServiceConfig {
  return loadServices(store).tts;
}

/** Merge a partial change; unknown provider ids fall back to "desktop default". */
export function saveSttConfig(
  patch: Partial<SttServiceConfig>,
  store: StorageLike | null = defaultStorage(),
): SttServiceConfig {
  const current = loadServices(store);
  const next = normalizeStt({ ...current.stt, ...patch });
  if (store) {
    try {
      store.setItem(SERVICES_KEY, JSON.stringify({ ...current, stt: next }));
    } catch {
      /* private mode: the config just will not persist */
    }
  }
  return next;
}

export function saveTtsConfig(
  patch: Partial<TtsServiceConfig>,
  store: StorageLike | null = defaultStorage(),
): TtsServiceConfig {
  const current = loadServices(store);
  const next = normalizeTts({ ...current.tts, ...patch });
  if (store) {
    try {
      store.setItem(SERVICES_KEY, JSON.stringify({ ...current, tts: next }));
    } catch {
      /* private mode: the config just will not persist */
    }
  }
  return next;
}

/** true when the provider runs in the tab and calls a remote service. */
export function isCloudSttProvider(id: string): boolean {
  return STT_PROVIDER_META.some((p) => p.id === id && p.cloud);
}
