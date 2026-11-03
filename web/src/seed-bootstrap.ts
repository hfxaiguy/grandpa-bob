/**
 * First-load seed bootstrap.
 *
 * A deployment can commit `public/seed-bootstrap.json` naming a BobSwap shelf.
 * When a profile has no workspace yet, the tab tries that shelf's newest public
 * archive before falling back to the bundled snapshot. The shelf must mark the
 * newest version public: a fresh browser has no read key, and no key is ever
 * baked into the bundle.
 *
 * The same shelf is the deployment's **open seeds** source: the Profiles
 * picker and the Seed dialog offer its names to everyone, with no service
 * configuration. `openSeeds` lists additional public names on that account;
 * the primary `seedName` is always included.
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
  /** Additional public names on the same account (the primary is implied). */
  openSeeds?: string[];
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
  if (!baseUrl) return null;

  // Accept both spellings: `openSeeds` is the documented field, `seeds` is a
  // convenient alias for a plain list. Invalid and duplicate entries are
  // dropped so one typo cannot hide the rest of the shelf.
  const extra: string[] = [];
  const seen = new Set([seedName]);
  for (const list of [record.openSeeds, record.seeds]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const name = entry.trim();
      if (!isValidSeedName(name) || seen.has(name)) continue;
      seen.add(name);
      extra.push(name);
    }
  }
  return extra.length
    ? { baseUrl, account, seedName, openSeeds: extra }
    : { baseUrl, account, seedName };
}

/** The primary seed followed by the deployment's additional open names. */
export function bootstrapSeedNames(seed: BootstrapSeed): string[] {
  return [...new Set([seed.seedName, ...(seed.openSeeds ?? [])])];
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

let cachedSeed: BootstrapSeed | null | undefined;
let loading: Promise<BootstrapSeed | null> | null = null;

/** The shelf loaded for this tab, when a boot already fetched it. */
export function cachedBootstrapSeed(): BootstrapSeed | null {
  return cachedSeed ?? null;
}

/**
 * Load the deployment's open-seed shelf. A `?bootstrap=` override wins for the
 * whole tab (it is how the smoke and one-off testing name a fake service).
 * Repeat calls share one request so boot and the Profiles dialog agree.
 */
export async function loadBootstrapSeed(search?: string): Promise<BootstrapSeed | null> {
  const query = search ?? (typeof location === "undefined" ? "" : location.search);
  const fromParams = bootstrapSeedFromParams(new URLSearchParams(query));
  if (fromParams) {
    cachedSeed = fromParams;
    return fromParams;
  }
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch("/seed-bootstrap.json", { cache: "no-cache" });
      if (!res.ok) return null;
      return parseBootstrapSeed(await res.json());
    } catch {
      return null;
    }
  })().then((seed) => {
    cachedSeed = seed ?? null;
    return seed;
  });
  return loading;
}
