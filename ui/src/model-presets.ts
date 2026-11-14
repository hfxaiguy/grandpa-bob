// Provider presets for the Settings → Models slot editor. Kept in a plain
// module so Node checks can assert the list without a DOM: presets only
// autofill the base URL and protocol, and every field stays editable.
//
// CommandCode exposes its Provider API under `/provider/v1`; grandma-kat
// appends `/chat/completions` to `baseURL`, so the preset must keep that
// path exactly (https://commandcode.ai/docs/provider).

export type ModelPreset = {
  label: string;
  baseURL: string;
  /** Native Ollama uses `/api/chat`; undefined means OpenAI-compatible. */
  protocol?: "ollama";
};

export const MODEL_PRESETS: Record<string, ModelPreset> = {
  "ollama-local": { label: "Ollama (local)", baseURL: "http://127.0.0.1:11434", protocol: "ollama" },
  "ollama-cloud": { label: "Ollama cloud", baseURL: "https://ollama.com", protocol: "ollama" },
  neuralwatt: { label: "Neuralwatt", baseURL: "https://api.neuralwatt.com/v1" },
  commandcode: {
    label: "CommandCode",
    baseURL: "https://api.commandcode.ai/provider/v1",
  },
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1" },
  openrouter: { label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  llamacpp: { label: "llama.cpp / LM Studio", baseURL: "http://127.0.0.1:1234/v1" },
  custom: { label: "Custom", baseURL: "" },
};

/** Match a saved slot back to its preset; `custom` when none matches. */
export function presetId(baseURL: unknown, protocol: unknown): string {
  const b = typeof baseURL === "string" ? baseURL : "";
  const p = typeof protocol === "string" ? protocol : "";
  for (const id in MODEL_PRESETS) {
    const pr = MODEL_PRESETS[id];
    if ((pr.baseURL || "") === b && (pr.protocol || "") === p) return id;
  }
  return "custom";
}
