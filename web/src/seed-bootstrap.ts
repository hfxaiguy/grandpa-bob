/**
 * First-load seed bootstrap.
 *
 * A deployment can commit `public/seed-bootstrap.json` naming a BobSwap shelf.
 * When a profile has no workspace yet, the tab tries that shelf's newest public
 * archive before falling back to the bundled snapshot. The shelf must mark the
 * newest version public: a fresh browser has no read key, and no key is ever
 * baked into the bundle.
 *
 * `?bootstrap=<account>/<seed>` (plus optional `?bootstrap-url=<origin>`)
 * overrides the file for one tab; the bootstrap smoke uses that to point a
 * fresh browser at a fake service.
 */
import { isValidSeedName } from "./profiles";
import { DEFAULT_SWAP_SERVICE_URL } from "./swap";

export interface BootstrapSeed {
  baseUrl: string;
  account: string;
  seedName: string;
}

function normalizeBaseUrl(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return DEFAULT_SWAP_SERVICE_URL;
  const scheme = /^https?:\/\//i.test(value);
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(value);
  const candidate = scheme ? value : `${isLocal ? "http" : "https"}://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Validate a `seed-bootstrap.json` payload (unknown fields are ignored). */
export function parseBootstrapSeed(raw: unknown): BootstrapSeed | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const account = typeof record.account === "string" ? record.account.trim() : "";
  const seedName = typeof record.seedName === "string" ? record.seedName.trim() : "";
  if (!isValidSeedName(account) || !isValidSeedName(seedName)) return null;
  const baseUrl = normalizeBaseUrl(
    typeof record.baseUrl === "string" ? record.baseUrl : DEFAULT_SWAP_SERVICE_URL,
  );
  return baseUrl ? { baseUrl, account, seedName } : null;
}

/** `?bootstrap=personal/trunk[&bootstrap-url=https://…]` */
export function bootstrapSeedFromParams(params: URLSearchParams): BootstrapSeed | null {
  const pair = params.get("bootstrap")?.trim() ?? "";
  const match = /^([^/]+)\/([^/]+)$/.exec(pair);
  if (!match) return null;
  return parseBootstrapSeed({
    baseUrl: params.get("bootstrap-url") ?? DEFAULT_SWAP_SERVICE_URL,
    account: match[1],
    seedName: match[2],
  });
}
