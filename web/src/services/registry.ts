/**
 * STT provider registry — metadata only.
 *
 * Implementations are injected where they can actually run: the Node channel
 * wraps the local whisper/sherpa/parakeet functions, the browser holds the
 * cloud adapters. Sharing just the ids and labels keeps one source of truth
 * without forcing Node-only code into `web/`.
 */

export interface ProviderMeta {
  id: string;
  label: string;
  cloud: boolean;
  /** Cloud providers that can be called directly from the tab (CORS allows it). */
  browser?: boolean;
}

export type SttProviderMeta = ProviderMeta;
export type TtsProviderMeta = ProviderMeta;

export const STT_PROVIDER_META: readonly SttProviderMeta[] = [
  { id: "whisper", label: "Whisper (local server)", cloud: false },
  { id: "sherpa", label: "Sherpa (local server)", cloud: false },
  { id: "parakeet", label: "Parakeet (local server)", cloud: false },
  { id: "assemblyai", label: "AssemblyAI (cloud)", cloud: true, browser: true },
  // Rime's upgrade requires an Authorization header: a browser WebSocket
  // cannot send one, so this provider goes through the desktop.
  { id: "rime", label: "Rime STT (cloud)", cloud: true, browser: false },
];

export const TTS_PROVIDER_META: readonly TtsProviderMeta[] = [
  { id: "kitten", label: "KittenTTS (local server)", cloud: false },
  // No CORS on mist.api.rime.ai (preflight 404s), so this runs on the desktop.
  { id: "rime", label: "Rime Mist v3 (cloud, via desktop)", cloud: true, browser: false },
];

export const LOCAL_STT_PROVIDERS: readonly string[] = STT_PROVIDER_META.filter((p) => !p.cloud).map(
  (p) => p.id,
);

export function isLocalSttProvider(id: string): boolean {
  return LOCAL_STT_PROVIDERS.includes(id);
}

/** true when the provider can run in the tab (cloud + CORS-friendly). */
export function isBrowserSttProvider(id: string): boolean {
  return STT_PROVIDER_META.some((p) => p.id === id && p.browser === true);
}
