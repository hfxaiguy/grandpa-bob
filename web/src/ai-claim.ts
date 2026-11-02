/**
 * BobSwap's free AI proxy: claim a short-lived OpenAI-compatible key and wire
 * it into the workspace model registry.
 *
 * The public claim endpoint hands out an `ai`-scope key with a small budget
 * (currently 25k tokens / 20 requests). It only works against the BobSwap
 * proxy — it is not a Neuralwatt key. Clients should claim once, keep the key
 * in browser settings, and reuse it until it expires; claiming on every load
 * burns the service-wide pool. See https://bobswap.hfxaiguy.com/docs/agents.
 *
 * Pure (no DOM, no localStorage) so Node tests can exercise the same rules the
 * browser backend uses.
 */

export const BOBSWAP_AI_BASE_URL = "https://bobswap.hfxaiguy.com/api/v1/ai";
export const BOBSWAP_AI_CLAIM_URL = `${BOBSWAP_AI_BASE_URL}/claim-key`;
/** Browser-settings variable the claimed key is stored under. */
export const BOBSWAP_AI_KEY_ENV = "BOBSWAP_AI_KEY";

const DEFAULT_V4_MODEL = "deepseek-v4-flash";
const DEFAULT_V41_MODEL = "deepseek-v4.1-flash";

export interface FreeKeyClaim {
  key: string;
  tokensRemaining: number | null;
  requestsRemaining: number | null;
  expiresAt: string | null;
  /** Empty (or ["*"]) when the service does not advertise a fixed allowlist. */
  allowedModels: string[];
}

export class ClaimError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ClaimError";
    this.status = status;
  }
}

const ENV_REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** Resolve a registry `apiKey` through the env map the way `parseModels` does. */
export function resolveModelKey(rawKey: unknown, env: Record<string, string | undefined>): string {
  if (typeof rawKey !== "string") return "";
  return rawKey.replace(ENV_REF, (_, name: string) => env[name] ?? "");
}

/** True for endpoints the claim flow can fix: Neuralwatt direct or BobSwap AI. */
export function isClaimableEndpoint(baseURL: unknown): boolean {
  if (typeof baseURL !== "string") return false;
  try {
    const url = new URL(baseURL);
    if (url.hostname === "api.neuralwatt.com") return true;
    return /\/api\/v1\/ai(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * True when the registry's claimable slots (the default `v4`/`v4.1` Neuralwatt
 * entries, or slots already pointed at the BobSwap proxy) have no usable key.
 * Invalid JSON never triggers the offer: the user must fix it in Settings.
 */
export function needsFreeKey(
  modelsJson: string,
  env: Record<string, string | undefined>,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelsJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  let candidates = 0;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!isClaimableEndpoint(entry.baseURL)) continue;
    candidates += 1;
    if (resolveModelKey(entry.apiKey, env).trim()) return false;
  }
  return candidates > 0;
}

/** Pick the v4 / v4.1 model ids from the key's allowlist (if it names one). */
function pickModels(allowed: string[]): { v4: string; v41: string } {
  const explicit = allowed.filter((id) => id && id !== "*");
  if (!explicit.length) return { v4: DEFAULT_V4_MODEL, v41: DEFAULT_V41_MODEL };
  const v41 = explicit.find((id) => /v4\.1/i.test(id)) ?? explicit[0];
  const v4 =
    explicit.find((id) => /v4(?!\.1)/i.test(id)) ??
    explicit.find((id) => id !== v41) ??
    explicit[0];
  return { v4, v41 };
}

/**
 * Rewrite (or create) the `v4` and `v4.1` slots to use the BobSwap proxy.
 * Everything else in the registry is left alone. The key is referenced as
 * `${BOBSWAP_AI_KEY}` so the workspace file (which can sync to a desktop)
 * never carries the secret itself.
 */
export function applyClaimedKey(
  modelsJson: string,
  allowedModels: string[] = [],
  keyEnv: string = BOBSWAP_AI_KEY_ENV,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelsJson);
  } catch (err) {
    throw new Error(
      `models.json is not valid JSON (${err instanceof Error ? err.message : String(err)}) — ` +
        "fix it in Settings → Models before claiming a key",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.json must be an object of name → entry");
  }
  const registry = parsed as Record<string, unknown>;
  const models = pickModels(allowedModels);

  const setSlot = (name: string, model: string): void => {
    const existing = registry[name];
    const base =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    // The proxy speaks the OpenAI-compatible protocol; an Ollama-native flag
    // would be wrong here (the claim flow only rewrites slots that were
    // already claimable, but keep the guard for hand-edited registries).
    delete base.protocol;
    registry[name] = {
      ...base,
      baseURL: BOBSWAP_AI_BASE_URL,
      model,
      apiKey: `\${${keyEnv}}`,
    };
  };
  setSlot("v4", models.v4);
  setSlot("v4.1", models.v41);
  // The default trees reference Model("cheap")/Model("strong"). Add the aliases
  // only when the registry has none (a hand-edited alias is left alone).
  if (registry.cheap === undefined) registry.cheap = "v4";
  if (registry.strong === undefined) registry.strong = "v4.1";
  return `${JSON.stringify(registry, null, 2)}\n`;
}

interface ClaimResponse {
  key?: unknown;
  tokens_remaining?: unknown;
  requests_remaining?: unknown;
  expires_at?: unknown;
  allowed_models?: unknown;
  error?: unknown;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Claim one free BobSwap AI key. The caller is responsible for persisting it —
 * never claim on page load or per request (each claim spends the shared pool).
 */
export async function claimFreeKey(
  fetchImpl: typeof fetch = fetch,
): Promise<FreeKeyClaim> {
  let res: Response;
  try {
    res = await fetchImpl(BOBSWAP_AI_CLAIM_URL, {
      method: "POST",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClaimError(
      `could not reach BobSwap (${detail}) — check your connection, ` +
        "or add a key manually in Settings → Credentials & .env",
    );
  }

  const data = (await res.json().catch(() => null)) as ClaimResponse | null;
  if (!res.ok) {
    const detail = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    if (res.status === 403) {
      throw new ClaimError(
        "BobSwap has public claiming turned off right now — add a key manually in " +
          "Settings → Credentials & .env",
        res.status,
      );
    }
    if (res.status === 429) {
      throw new ClaimError(
        "The free-key pool is busy right now (rate limited) — try again later, " +
          "or add your own key in Settings → Credentials & .env",
        res.status,
      );
    }
    throw new ClaimError(`claim failed: ${detail}`, res.status);
  }

  if (!data || typeof data.key !== "string" || !data.key.startsWith("bsk_live_")) {
    throw new ClaimError("claim failed: BobSwap returned an unexpected response");
  }
  const allowed = Array.isArray(data.allowed_models)
    ? data.allowed_models.filter((id): id is string => typeof id === "string")
    : [];
  return {
    key: data.key,
    tokensRemaining: numberOrNull(data.tokens_remaining),
    requestsRemaining: numberOrNull(data.requests_remaining),
    expiresAt: typeof data.expires_at === "string" ? data.expires_at : null,
    allowedModels: allowed,
  };
}
