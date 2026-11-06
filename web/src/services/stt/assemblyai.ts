import type { AudioClip, SttAdapter, SttAdapterContext, Transcript } from "../types";

/**
 * AssemblyAI Sync STT, called straight from the tab.
 *
 * Browser CORS was verified on 2026-11-05: preflight allows
 * `Authorization` + `X-AAI-Model`, and the actual responses (including errors)
 * carry `access-control-allow-origin: *`. Auth failures come back as
 * `404 {"detail":"Invalid API key"}` — not 401/403 — so they are mapped to a
 * message that names the fix.
 */
export const ASSEMBLYAI_ENDPOINT = "https://sync.assemblyai.com/v1/transcribe";
export const ASSEMBLYAI_MODEL = "universal-3-5-pro";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function audioMime(ext: string): string {
  switch (ext) {
    case ".webm":
      return "audio/webm";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

function headersFor(apiKey: string): Record<string, string> {
  return { authorization: apiKey, "x-aai-model": ASSEMBLYAI_MODEL };
}

export async function transcribeAssemblyAi(
  clip: AudioClip,
  ctx: SttAdapterContext,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<Transcript> {
  if (!ctx.apiKey) throw new Error("no AssemblyAI key — add it in Settings → Speech");
  const form = new FormData();
  // Copy into an ArrayBuffer-backed view so the Blob part satisfies the DOM
  // typings regardless of where the caller's bytes came from.
  const bytes = new Uint8Array(clip.bytes.byteLength);
  bytes.set(clip.bytes);
  form.append("audio", new Blob([bytes], { type: audioMime(clip.ext) }), `audio${clip.ext}`);
  if (ctx.language) form.append("language_code", ctx.language);

  const res = await fetchImpl(ASSEMBLYAI_ENDPOINT, {
    method: "POST",
    headers: headersFor(ctx.apiKey),
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as {
    text?: string;
    detail?: string;
    title?: string;
  };
  if (!res.ok) {
    const detail = String(data.detail ?? data.title ?? "");
    if (res.status === 404 && /invalid api key/i.test(detail)) {
      throw new Error("AssemblyAI rejected the key — check it in Settings → Speech");
    }
    throw new Error(`AssemblyAI failed: ${detail || `HTTP ${res.status}`}`);
  }
  return { text: String(data.text ?? "").trim() };
}

/**
 * Cheap auth probe for the Settings "Test" button: a body-less POST.
 * The service validates the key before the body, so 404 = rejected and
 * 400/422 = key accepted (nothing to transcribe).
 */
export async function probeAssemblyAi(
  apiKey: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const res = await fetchImpl(ASSEMBLYAI_ENDPOINT, {
      method: "POST",
      headers: headersFor(apiKey),
      body: new FormData(),
    });
    return res.status !== 404;
  } catch {
    return false;
  }
}

export const assemblyAiStt: SttAdapter = {
  id: "assemblyai",
  label: "AssemblyAI (cloud)",
  endpoint: ASSEMBLYAI_ENDPOINT,
  cloud: true,
  transcribe: (clip, ctx) => transcribeAssemblyAi(clip, ctx),
  check: (ctx) => probeAssemblyAi(ctx.apiKey ?? ""),
};
