const EXA_SEARCH_URL = "https://api.exa.ai/search";
const TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 8_000;

/**
 * OpenAI tool schema for `exa_search`. Shared by the Node registry
 * (`src/tools/index.ts`) and the browser registry
 * (`web/src/agent/browser-tools.ts`) so the two targets cannot drift.
 */
export const EXA_SEARCH_DEFINITION = {
  type: "function" as const,
  function: {
    name: "exa_search",
    description:
      "Search the web via the Exa Search API. Returns structured data: a JSON object with " +
      "'query', 'count', and 'results', where each result has title, url, publishedDate, " +
      "highlights (query-relevant excerpts) and text (page content up to 8000 chars). " +
      "Use for current events, facts, research, or anything requiring up-to-date web information.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        type: {
          type: "string",
          enum: ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"],
          description: "Search method (default 'auto'). 'fast'/'instant' for speed, 'deep' variants for multi-step research.",
        },
        numResults: { type: "integer", description: "Number of results (1-100, default 5)" },
        category: {
          type: "string",
          enum: ["company", "people", "publication", "news", "personal site", "financial report"],
          description: "Focus on a specific content type (default: any)",
        },
        includeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Only return results from these domains (e.g. ['reuters.com'])",
        },
        startPublishedDate: { type: "string", description: "ISO 8601 date — only results published after this date" },
        endPublishedDate: { type: "string", description: "ISO 8601 date — only results published before this date" },
      },
      required: ["query"],
    },
  },
};

const CATEGORIES = new Set([
  "company", "people", "publication", "news", "personal site", "financial report",
]);

const SEARCH_TYPES = new Set(["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"]);

export interface ExaSearchArgs {
  query: string;
  type?: string;
  numResults?: number;
  category?: string;
  includeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
}

interface ExaResult {
  title?: string | null;
  url?: string | null;
  publishedDate?: string | null;
  highlights?: string[];
  text?: string | null;
}

interface ExaResponse {
  results?: ExaResult[];
}

export interface ExaSearchOutput {
  query: string;
  count: number;
  results: ExaResult[];
  [key: string]: string | number | ExaResult[];
}

export class ExaSearchTools {
  constructor(private apiKey: string) {}

  /**
   * Structured search result: a plain JSON object. Errors (bad key,
   * API failure, etc.) are returned as "error:" strings instead — never
   * thrown — so the agent can recover. No truncation is applied: the full
   * object is returned as-is.
   */
  async search(args: ExaSearchArgs): Promise<string | ExaSearchOutput> {
    if (!this.apiKey) {
      return "error: web search not configured (set EXO_API_KEY in .env)";
    }
    const query = String(args.query ?? "").trim();
    if (!query) return "error: missing required argument: query";

    const body: Record<string, unknown> = {
      query,
      type: args.type ?? "auto",
      numResults: Math.min(Math.max(Math.floor(args.numResults ?? 5), 1), 100),
      contents: {
        highlights: true,
        text: { maxCharacters: MAX_TEXT_CHARS },
      },
    };
    if (args.category) {
      if (!CATEGORIES.has(args.category)) {
        return `error: invalid category "${args.category}" (allowed: ${[...CATEGORIES].join(", ")})`;
      }
      body.category = args.category;
    }
    if (args.type && !SEARCH_TYPES.has(args.type)) {
      return `error: invalid type "${args.type}" (allowed: ${[...SEARCH_TYPES].join(", ")})`;
    }
    if (args.includeDomains?.length) body.includeDomains = args.includeDomains;
    if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate;
    if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(EXA_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      return `error: exa API ${err instanceof Error && err.name === "AbortError" ? `timed out after ${TIMEOUT_MS / 1000}s` : `request failed: ${err instanceof Error ? err.message : String(err)}`}`;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        if (text) detail += `: ${text.slice(0, 500)}`;
      } catch {
        // ignore body read failure
      }
      return `error: exa API ${detail}`;
    }

    let data: ExaResponse;
    try {
      data = (await res.json()) as ExaResponse;
    } catch {
      return "error: exa API returned invalid JSON";
    }

    const results = (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      publishedDate: r.publishedDate ?? null,
      highlights: r.highlights ?? [],
      text: r.text ?? null,
    }));

    return { query, count: results.length, results };
  }
}
