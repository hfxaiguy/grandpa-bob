// src/tools/json.ts
//
// One agent tool: read_json — parse content that might be JSON as JSON.
//
// Three sources, exactly one per call:
//   - `path`: a workspace-relative file (the caller supplies the sandboxed reader)
//   - `text`: a JSON string already in context (another tool's output, a message)
//   - `ref`:  a `ref://<name>.<seq>[/path]` handle to a value the run log holds
//             whole (the engine resolves it; a string payload is parsed)
//
// The result is structured — `{ json: <value> }` — so the engine's ref handles
// and row-trimming apply to it like any object tool result, and the model gets
// structure instead of an escaped text blob.
//
// `at` walks into the resolved value with the SAME dialect as grandma-kat's
// refs and inspect_memory: a `/`-separated path of object keys and array
// indices (`rows/0/email`). A ref may carry that path itself; `at` composes
// after it.
//
// Parsing is deliberately STRICT JSON (JSON.parse after trimming whitespace
// and a BOM): predictable for files like models.json / package.json. The error
// says what failed and — when every line parses on its own — that the content
// is JSONL, so the model can pick another tool instead of retrying blindly.
//
// This module is platform-free: the Node registry and the browser worker both
// import it (the browser build bundles it), exactly like tool-guides.ts.

/** Cap on the content handed to JSON.parse (chars, after trim). */
export const MAX_JSON_CHARS = 2_000_000;

/** Resolve a `ref://` handle against this run's log (the engine's ctx.readRef). */
export type ReadRef = (ref: string) => unknown;

export interface JsonReadArgs {
  path?: unknown;
  text?: unknown;
  ref?: unknown;
  /** Optional `/`-separated walk into the resolved value (or an array of steps). */
  at?: unknown;
}

export interface JsonReadOptions {
  /** Read a workspace-relative file as UTF-8 text (sandboxed by the caller). */
  readFile: (rel: string) => Promise<string>;
  /** The run's ref resolver; absent outside a live run context. */
  readRef?: ReadRef;
}

export interface JsonReadResult {
  json: unknown;
  /** Echoed when `at` walked into the value; absent for a whole-value read. */
  at?: string;
}

const SOURCES = ["path", "text", "ref"] as const;

/** Strict JSON.parse with actionable failures (BOM/whitespace tolerated). */
export function parseJsonContent(raw: string): unknown {
  const text = String(raw ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("content is empty — not JSON");
  if (text.length > MAX_JSON_CHARS) {
    throw new Error(
      `content is ${text.length} chars — too large to parse as JSON (limit ${MAX_JSON_CHARS}); ` +
        "read a smaller slice or use a query tool instead",
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((line) => isJsonLine(line))) {
      throw new Error(
        `not a single JSON value — content looks like JSONL (${lines.length} lines, each parses on its own); ` +
          "read_json reads one value, so read the lines with read_file instead",
      );
    }
    throw new Error(`not valid JSON: ${detail} — use read_file to inspect the raw content`);
  }
}

function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk steps from a `/`-separated path (or an already-split array).
 * Same dialect as grandma-kat's ref paths and inspect_memory: array segments
 * are indices, everything else is an object key.
 */
export function jsonPathSteps(at: unknown): string[] {
  if (at === undefined || at === null) return [];
  if (Array.isArray(at)) return at.map(String).filter((step) => step !== "");
  if (typeof at !== "string") throw new Error("at must be a /-separated string");
  return at.trim().split("/").filter((step) => step !== "");
}

/** Walk a path into a value; undefined when a step misses (the caller errors). */
export function walkJson(value: unknown, steps: string[]): unknown {
  let cur = value;
  for (const step of steps) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur)
      ? cur[Number(step)]
      : (cur as Record<string, unknown>)[step];
  }
  return cur;
}

/**
 * Resolve one source, strictly parse it when it is text, then apply `at`.
 * Returns `{ json }` (plus the echoed `at` when a walk happened).
 */
export async function readJsonValue(
  args: JsonReadArgs,
  opts: JsonReadOptions,
): Promise<JsonReadResult> {
  const given = SOURCES.filter((key) => args[key] !== undefined && args[key] !== null && args[key] !== "");
  if (given.length === 0) {
    throw new Error(
      'missing source: pass one of "path" (a workspace file), "text" (a JSON string) or "ref" (a ref://<name>.<seq> handle)',
    );
  }
  if (given.length > 1) {
    throw new Error(`pass exactly one of "path", "text" or "ref" (got ${given.join(", ")})`);
  }

  let value: unknown;
  const source = given[0];
  if (source === "path") {
    value = parseJsonContent(await opts.readFile(String(args.path)));
  } else if (source === "text") {
    value = parseJsonContent(String(args.text));
  } else {
    const ref = String(args.ref).trim();
    if (!opts.readRef) {
      throw new Error('"ref" needs a live run context — the handle is resolved from this run\'s log');
    }
    value = opts.readRef(ref);
    // A ref usually points at a tool result, which may itself be a JSON string
    // (e.g. an API response kept whole). Objects/arrays come back already parsed.
    if (typeof value === "string") value = parseJsonContent(value);
    if (value === undefined) throw new Error(`ref ${ref}: no value`);
  }

  const steps = jsonPathSteps(args.at);
  if (steps.length === 0) return { json: value };
  const walked = walkJson(value, steps);
  if (walked === undefined) {
    throw new Error(`at "${steps.join("/")}" not found in the resolved JSON`);
  }
  return { json: walked, at: steps.join("/") };
}

/** OpenAI tool schema, shared by the Node registry and the browser worker. */
export const READ_JSON_DEFINITION = {
  type: "function" as const,
  function: {
    name: "read_json",
    description:
      "Read content that is (or might be) JSON as a structured value. Pass exactly one source: " +
      '"path" for a workspace file, "text" for a JSON string already in context, or "ref" for a ' +
      "ref://<name>.<seq> handle to a value the run log holds whole (a truncated tool result). " +
      "Returns { json: <value> } — structure, not an escaped text blob — so large values come back " +
      'as ref:// handles. Add "at" to walk into the value: a /-separated path of object keys and ' +
      'array indices, e.g. "rows/0/email" (a ref may carry the same path itself). Strict JSON only: ' +
      "on a parse error the message says why (including when the content looks like JSONL); use " +
      "read_file for raw text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path containing JSON." },
        text: { type: "string", description: "A JSON string to parse (e.g. another tool's JSON output)." },
        ref: {
          type: "string",
          description: "A ref://<name>.<seq>[/path] handle to resolve from this run's log.",
        },
        at: {
          type: "string",
          description:
            "Optional /-separated path to walk into the value after it resolves: object keys and " +
            "array indices, e.g. \"rows/0/email\" (or an array of steps).",
        },
      },
    },
  },
};
