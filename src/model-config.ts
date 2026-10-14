// Pure model-registry parsing. No Node builtins, so the browser target can
// reuse it: the Node loader (models.ts) reads models.json from disk, the
// browser reads it from OPFS, and both hand the text to `parseModels`.
//
// Each entry has the shape grandma-kat expects:
//   { baseURL, apiKey, model, transform?, protocol? }
//
// String values are interpolated against the supplied env map: "${OLLAMA_API_KEY}"
// becomes whatever OLLAMA_API_KEY is set to. Use "$$" for a literal "$".

export type ModelTransform = (
  response: {
    content: string;
    reasoning: string | null;
    tool_calls: unknown[] | null;
    raw: unknown;
  },
  ctx: { messages: unknown; tools: unknown; model: string },
) => {
  content?: string;
  reasoning?: string | null;
  tool_calls?: unknown[] | null;
} | null | undefined;

/**
 * Protocol-specific reasoning controls, forwarded to the endpoint at call time
 * (see grandma-kat's src/llm.mjs). On an OpenAI-compatible endpoint
 * `reasoning_effort` is sent verbatim; on native Ollama `think` is sent
 * top-level and `options` is merged into the request's `options`.
 */
export type ModelThinking = {
  /** OpenAI-compatible: sent as the request's `reasoning_effort`. */
  reasoning_effort?: string | number;
  /** Ollama native: sent as the request's top-level `think` flag. */
  think?: boolean;
  /** Ollama native: merged into the request's `options` object. */
  options?: Record<string, unknown>;
};

export type ModelEntry = {
  baseURL: string;
  apiKey: string;
  model: string;
  transform?: ModelTransform;
  /**
   * "ollama" uses Ollama's native /api/chat endpoint; undefined (default) uses
   * the OpenAI-compatible /chat/completions endpoint.
   */
  protocol?: "ollama";
  /** Optional reasoning level / thinking controls for this model slot. */
  thinking?: ModelThinking;
};

export type ModelRegistry = Record<string, ModelEntry>;

export type EnvMap = Record<string, string | undefined>;

function interpolate(value: string, env: EnvMap): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => env[name] ?? "");
}

/** Built-in response transforms, referenced by name in models.json. */
export const BUILTIN_TRANSFORMS: Record<string, ModelTransform> = {
  /**
   * Strip Gemma 4's channel-wrapped thinking tags from content and populate
   * the reasoning field from the thinking block.
   */
  gemma4Thinking: (r) => {
    const m = r.content.match(/<\|channel\|>thought\n([\s\S]*?)<channel\|>/);
    return {
      content: r.content.replace(/<\|channel\|>thought\n[\s\S]*?<channel\|>/g, "").trim(),
      reasoning: r.reasoning || (m?.[1]?.trim() ?? null),
    };
  },
};

function normalizeEntry(raw: unknown, name: string, env: EnvMap): ModelEntry {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`models.json: entry "${name}" must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.baseURL !== "string") {
    throw new Error(`models.json: entry "${name}" is missing required string "baseURL"`);
  }
  if (typeof r.model !== "string" || r.model.length === 0) {
    throw new Error(`models.json: entry "${name}" is missing required string "model"`);
  }
  const entry: ModelEntry = {
    baseURL: interpolate(r.baseURL, env),
    apiKey: interpolate(typeof r.apiKey === "string" ? r.apiKey : "", env),
    model: interpolate(r.model, env),
  };
  if (typeof r.transform === "string" && r.transform.length > 0) {
    const t = BUILTIN_TRANSFORMS[r.transform];
    if (!t) {
      throw new Error(
        `models.json: entry "${name}" references unknown transform "${r.transform}". ` +
          `Available: ${Object.keys(BUILTIN_TRANSFORMS).join(", ") || "(none)"}`,
      );
    }
    entry.transform = t;
  }
  if (r.protocol === "ollama") {
    entry.protocol = "ollama";
  }
  if (r.thinking !== undefined) {
    if (r.thinking === null || typeof r.thinking !== "object" || Array.isArray(r.thinking)) {
      throw new Error(`models.json: entry "${name}" field "thinking" must be an object`);
    }
    const t = r.thinking as Record<string, unknown>;
    const thinking: ModelThinking = {};
    if (t.reasoning_effort !== undefined) {
      if (typeof t.reasoning_effort !== "string" && typeof t.reasoning_effort !== "number") {
        throw new Error(
          `models.json: entry "${name}" thinking.reasoning_effort must be a string or number`,
        );
      }
      thinking.reasoning_effort = t.reasoning_effort;
    }
    if (t.think !== undefined) {
      if (typeof t.think !== "boolean") {
        throw new Error(`models.json: entry "${name}" thinking.think must be a boolean`);
      }
      thinking.think = t.think;
    }
    if (t.options !== undefined) {
      if (t.options === null || typeof t.options !== "object" || Array.isArray(t.options)) {
        throw new Error(`models.json: entry "${name}" thinking.options must be an object`);
      }
      thinking.options = t.options as Record<string, unknown>;
    }
    if (Object.keys(thinking).length > 0) entry.thinking = thinking;
  }
  return entry;
}

/** Parse and validate model-registry JSON. Throws on invalid input. */
export function parseModels(raw: string, env: EnvMap = {}): ModelRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`models.json: invalid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.json: top-level value must be an object of name -> entry");
  }
  const out: ModelRegistry = {};
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    out[name] = normalizeEntry(entry, name, env);
  }
  if (Object.keys(out).length === 0) {
    throw new Error("models.json: no model entries defined");
  }
  return out;
}
