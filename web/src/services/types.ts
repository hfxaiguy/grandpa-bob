/**
 * Shared speech-service contracts. These types are the boundary between the
 * browser tab (cloud adapters) and the Node channel (local adapters); they
 * intentionally stay small — add a field only when a second consumer needs it.
 */

/** Raw audio plus its container extension (".webm", ".ogg", ".wav", …). */
export interface AudioClip {
  bytes: Uint8Array;
  ext: string;
}

export interface Transcript {
  text: string;
}

/** Per-request adapter context. Local adapters read the local server URLs. */
export interface SttAdapterContext {
  whisperUrl?: string;
  sherpaUrl?: string;
  tmpDir?: string;
  language?: string;
  /** Cloud adapters only: the key entered in Settings, attached per request. */
  apiKey?: string;
}

export interface SttAdapter {
  id: string;
  label: string;
  /** Cloud endpoint; doubles as the relay allowlist entry. Absent for local adapters. */
  endpoint?: string;
  /** true = the adapter runs in the browser tab and calls a remote service. */
  cloud?: boolean;
  transcribe(clip: AudioClip, ctx: SttAdapterContext): Promise<Transcript>;
  /** Reachability/auth probe for the Settings "Test" button. */
  check?(ctx: SttAdapterContext): Promise<boolean>;
}

/** Per-request TTS context. `endpoint` is the local service base URL. */
export interface TtsAdapterContext {
  endpoint?: string;
  voice?: string;
  language?: string;
  apiKey?: string;
}

export interface TtsAdapter {
  id: string;
  label: string;
  endpoint?: string;
  cloud?: boolean;
  synthesize(text: string, ctx: TtsAdapterContext): Promise<AudioClip>;
  check?(ctx: TtsAdapterContext): Promise<boolean>;
}
