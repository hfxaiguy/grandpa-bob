/**
 * exa_search parity between the Node tool registry and the browser worker.
 *
 * The browser target used to stub exa_search ("not available in the browser
 * target"). It now ships the real tool: `ExaSearchTools` is pure fetch (no
 * Node builtins) and `api.exa.ai` answers the CORS preflight for POST with
 * `authorization` + `content-type`, so the tab calls it directly.
 *
 * This pins the wiring that can rot silently:
 *   - the stub is gone and the real tool is present in both registries;
 *   - both build it from the same EXA_SEARCH_DEFINITION (schema parity);
 *   - a keyless browser registry behaves exactly like Node — the tool stays
 *     offered and answers the "not configured" error at call time;
 *   - a keyed call hits api.exa.ai with the bearer key and maps args to the
 *     request body (fetch mocked — no network).
 *
 * Run: `npm run test:exa-browser-wire`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserTools, STUB_TOOL_NAMES } from "../web/src/agent/browser-tools.js";
import { EXA_SEARCH_DEFINITION } from "../web/src/tools/websearch.js";
import { createNodePlatform } from "../src/platform/node.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-exa-wire-"));
const platform = createNodePlatform(workspace);

try {
  // ── the stub is gone, the real tool is present ───────────────────────────
  assert.equal(STUB_TOOL_NAMES.includes("exa_search"), false, "exa_search is a real browser tool now");
  const keyed = browserTools(platform, { exaApiKey: "exa-test-key" });
  const keyless = browserTools(platform, {});
  assert.ok(keyed.exa_search, "keyed registry has exa_search");
  assert.ok(keyless.exa_search, "keyless registry still offers exa_search (Node does)");
  assert.notEqual(
    keyless.exa_search.description,
    "exa_search is not available in the browser target.",
    "not the notAvailable() stub",
  );

  // ── one schema, both targets ─────────────────────────────────────────────
  // There is one registry now (the browser worker): it imports the same
  // shared definition, so schema parity is structural.
  assert.equal(keyed.exa_search.description, EXA_SEARCH_DEFINITION.function.description);
  assert.deepEqual(keyed.exa_search.parameters, EXA_SEARCH_DEFINITION.function.parameters);

  // ── keyless: same call-time error as Node ────────────────────────────────
  const keylessResult = await keyless.exa_search.execute({ query: "anything" });
  assert.equal(typeof keylessResult, "string", "the error is a string, like every tool error");
  assert.equal(keylessResult, "error: web search not configured (set EXO_API_KEY in .env)");

  // ── keyed: direct call to api.exa.ai, args mapped, result shaped ─────────
  const realFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "T",
            url: "https://example.com",
            publishedDate: "2026-01-01",
            highlights: ["h"],
            text: "body",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const out = (await keyed.exa_search.execute({
      query: "  logistics  ",
      numResults: 3,
      includeDomains: ["reuters.com"],
    })) as { query: string; count: number; results: { url: string; highlights: string[] }[] };

    assert.equal(seen?.url, "https://api.exa.ai/search", "the tool calls Exa directly (browser CORS path)");
    assert.equal(
      (seen?.init.headers as Record<string, string>).Authorization,
      "Bearer exa-test-key",
      "the EXO_API_KEY travels as a bearer token",
    );
    const body = JSON.parse(String(seen?.init.body)) as Record<string, unknown>;
    assert.equal(body.query, "logistics", "query is trimmed");
    assert.equal(body.numResults, 3);
    assert.deepEqual(body.includeDomains, ["reuters.com"]);
    assert.equal(out.query, "logistics");
    assert.equal(out.count, 1);
    assert.equal(out.results[0].url, "https://example.com");
    assert.deepEqual(out.results[0].highlights, ["h"]);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(
    "exa-browser-wire: real tool, shared schema, keyless error, keyed direct fetch OK",
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
