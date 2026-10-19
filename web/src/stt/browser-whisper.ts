/**
 * Browser-local speech-to-text: whisper via Transformers.js (onnxruntime-web).
 *
 * The model runs in the tab (WebGPU when available, WASM otherwise) and is
 * downloaded once, then cached by the browser. This replaces the Node target's
 * GPU whisper-server for the web UI, so voice input keeps working with no
 * server process at all.
 *
 * The heavy dependency is imported dynamically so the chat bundle stays small
 * and browsers that never dictate never download it.
 */

const DEFAULT_MODEL = "onnx-community/whisper-tiny.en";
const MODEL_KEY = "bob:whisper-model";

export function whisperModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function setWhisperModel(model: string): void {
  try {
    if (model.trim()) localStorage.setItem(MODEL_KEY, model.trim());
    else localStorage.removeItem(MODEL_KEY);
  } catch {
    /* private mode */
  }
}

export function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let pipelinePromise: Promise<any> | null = null;
let loadedWith: string | null = null;

async function getPipeline(): Promise<any> {
  const model = whisperModel();
  const key = `${model}|${hasWebGPU() ? "webgpu" : "wasm"}`;
  if (pipelinePromise && loadedWith === key) return pipelinePromise;
  loadedWith = key;
  pipelinePromise = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    if (hasWebGPU()) {
      try {
        return await pipeline("automatic-speech-recognition", model, {
          device: "webgpu",
          dtype: "fp32",
        });
      } catch (err) {
        console.warn("[whisper] webgpu unavailable, falling back to wasm:", err);
      }
    }
    return pipeline("automatic-speech-recognition", model, {
      device: "wasm",
      dtype: "q8",
    });
  })();
  return pipelinePromise;
}

/** Decode any browser-recorded audio blob to mono Float32 PCM at 16 kHz. */
async function toMono16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext is unavailable in this browser");
  // Constructing at 16 kHz makes decodeAudioData resample for us.
  const ctx = new Ctor({ sampleRate: 16000 });
  try {
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    const channels = buffer.numberOfChannels;
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels;
    }
    return mono;
  } finally {
    void ctx.close();
  }
}

/** Transcribe one recorded clip. Throws with a readable message on failure. */
export async function transcribeBlob(blob: Blob): Promise<string> {
  if (!blob.size) throw new Error("recording is empty");
  const [transcriber, audio] = await Promise.all([getPipeline(), toMono16k(blob)]);
  const output = await transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: "en",
    task: "transcribe",
  });
  const text = Array.isArray(output)
    ? output.map((o: { text?: string }) => o.text ?? "").join(" ")
    : (output as { text?: string }).text ?? "";
  return text.trim();
}
