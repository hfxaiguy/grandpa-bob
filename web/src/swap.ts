/**
 * BobSwap client: the seed shelf.
 *
 * Server contract (https://bobswap.hfxaiguy.com/docs/agents):
 *   GET  /api/v1/{account}/{seed}/latest/meta?key=…   → tiny freshness record
 *   GET  /api/v1/{account}/{seed}/latest?key=…        → archive JSON (ETag/304)
 *   PUT  /api/v1/{account}/{seed}/{id-and-version}    → upload (Bearer, upload scope)
 *   GET  /api/v1/{account}/seeds?key=…                → seed listing
 *
 * Cross-device workspace traffic does not pass through this client: it uses
 * the WebRTC sync channel (`sync/transport-webrtc.ts`), whose signaling is a
 * separate BobSwap REST mailbox.
 */
import type { WorkspaceArchive } from "./workspace-transfer";
import { parseSeedMeta, type SeedMeta } from "./seed-version";
import { isValidSeedName, seedVersionCreatedAt, seedVersionTag } from "./profiles";

// ── service configuration (localStorage) ─────────────────────────────────

export interface SwapService {
  /** REST base, e.g. `https://bobswap.example.com`. Keys route to /api/v1. */
  baseUrl: string;
  /** Account namespace the keys belong to (BobSwap keys are account-bound). */
  account?: string;
  /** Read-scope BobSwap key (listing and reading seeds). */
  readKey?: string;
  /** Upload-scope BobSwap key (publishing seeds). */
  uploadKey?: string;
}

export interface SwapStore {
  active?: string;
  services: Record<string, SwapService>;
}

const STORE_KEY = "bob:swap";

/** Default BobSwap deployment; any saved service overrides it. */
export const DEFAULT_SWAP_SERVICE_URL = "https://bobswap.hfxaiguy.com";

/** A keyless default entry: enough to open the dialogs and show what to add. */
export function defaultSwapService(): SwapService {
  return {
    baseUrl: DEFAULT_SWAP_SERVICE_URL,
  };
}

/**
 * A keyless view of any deployment. Public/open seeds are readable without a
 * saved service, so a binding must not require one just to build the URL.
 */
export function keylessSwapService(baseUrl: string, account?: string): SwapService {
  const normalized = normalizeBaseUrl(baseUrl) || DEFAULT_SWAP_SERVICE_URL;
  return account ? { baseUrl: normalized, account } : { baseUrl: normalized };
}

function normalizeBaseUrl(raw: string): string {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(value);
  return `${isLocal ? "http" : "https"}://${value}`;
}

export function loadSwapStore(): SwapStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SwapStore) : null;
    if (!parsed || typeof parsed !== "object" || !parsed.services) return { services: {} };
    return { active: parsed.active, services: parsed.services };
  } catch {
    return { services: {} };
  }
}

export function saveSwapStore(store: SwapStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* private mode */
  }
}

/** Save (or replace) a service entry and make it active. */
export function saveSwapService(service: SwapService): SwapService {
  const baseUrl = normalizeBaseUrl(service.baseUrl);
  if (!baseUrl) throw new Error("service URL is required");
  const stored: SwapService = { ...service, baseUrl };
  const store = loadSwapStore();
  store.services[baseUrl] = stored;
  store.active = baseUrl;
  saveSwapStore(store);
  return stored;
}

export function activeSwapService(): SwapService | null {
  const store = loadSwapStore();
  const key = store.active && store.services[store.active] ? store.active : Object.keys(store.services)[0];
  return key ? store.services[key] : null;
}

export function listSwapServices(): SwapService[] {
  return Object.values(loadSwapStore().services);
}

/** Look up the service that owns a seed binding's baseUrl. */
export function serviceFor(baseUrl: string): SwapService | null {
  const store = loadSwapStore();
  const key = normalizeBaseUrl(baseUrl);
  return store.services[key] ?? null;
}

/**
 * Saved service for a URL, or the built-in default deployment (which has no
 * API keys) so dialogs can show what is missing instead of a bare error.
 */
export function resolveSwapService(baseUrl: string | undefined): SwapService | null {
  if (!baseUrl) return null;
  const saved = serviceFor(baseUrl);
  if (saved) return saved;
  return normalizeBaseUrl(baseUrl) === DEFAULT_SWAP_SERVICE_URL ? defaultSwapService() : null;
}

// ── small helpers ────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256HexText(text: string): Promise<string> {
  return sha256HexBytes(encoder.encode(text));
}

function apiBase(service: SwapService): string {
  return `${service.baseUrl.replace(/\/+$/, "")}/api/v1`;
}

function requireKey(service: SwapService, scope: "read" | "upload"): string {
  const key = scope === "upload" ? service.uploadKey : service.readKey;
  if (!key) {
    throw new Error(
      `this BobSwap service has no ${scope} key yet — add one in Sync… → BobSwap…`,
    );
  }
  return key;
}

/** A read key, or undefined when only public versions are readable. */
function readKeyOf(service: SwapService): string | undefined {
  return service.readKey?.trim() || undefined;
}

/**
 * Full SHA-256 advertised in an `ETag` header. Public seed downloads carry the
 * same hash as `/latest/meta`'s `sha256`, so a keyless read can still verify
 * the bytes; tolerate quoting and weak validators.
 */
export function sha256FromEtag(value: string | null): string | undefined {
  const cleaned = String(value ?? "").trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  return /^[0-9a-f]{64}$/i.test(cleaned) ? cleaned.toLowerCase() : undefined;
}

/**
 * Firefox reports a truncated response body as `Content-Length header of
 * network response exceeds response Body`; Chromium says `Failed to fetch`,
 * and Node's fetch says `terminated other side closed`. These are transient
 * transport failures (a suspended keep-alive connection, a flaky proxy), not
 * bad requests, so a retry is safe for the GET/HEAD calls here.
 */
const TRANSIENT_NETWORK_ERROR =
  /Content-Length header of network response exceeds response Body|NetworkError when attempting to fetch resource|Failed to fetch|Load failed|fetch failed|terminated other side closed/i;

async function retryTransient<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= attempts || !TRANSIENT_NETWORK_ERROR.test(message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

async function apiError(res: Response): Promise<Error> {
  let message = `BobSwap request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = `${body.error} (${res.status})`;
  } catch {
    /* non-JSON error body */
  }
  return new Error(message);
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── seeds ────────────────────────────────────────────────────────────────

export interface RemoteSeedMeta extends SeedMeta {
  seed_id_and_version?: string;
  sha256?: string;
  size?: number;
  fileCount?: number;
  /** Server-side upload timestamp (what `/latest` resolves by). */
  uploaded_at?: string;
}

/**
 * Validate a `/latest/meta` payload. The client once cast the JSON blindly,
 * which could turn a service-side shape change into a silent "current" (the
 * timestamp compare treats an unparseable `createdAt` as no update). Malformed
 * metadata is now an error the caller can surface.
 */
export function parseRemoteSeedMeta(raw: unknown): RemoteSeedMeta | null {
  const base = parseSeedMeta(raw);
  if (!base) return null;
  const record = raw as Record<string, unknown>;
  const labelled =
    typeof record.seed_id_and_version === "string" ? record.seed_id_and_version.trim() : "";
  const uploaded =
    typeof record.uploaded_at === "string" && !Number.isNaN(Date.parse(record.uploaded_at))
      ? record.uploaded_at
      : undefined;
  return {
    ...base,
    seed_id_and_version: labelled || undefined,
    uploaded_at: uploaded,
  };
}

/** Freshness record of a seed's newest version; null when unavailable. */
export async function fetchLatestSeedMeta(
  service: SwapService,
  account: string,
  seedName: string,
): Promise<RemoteSeedMeta | null> {
  const key = requireKey(service, "read");
  const url = `${apiBase(service)}/${encodeURIComponent(account)}/${encodeURIComponent(seedName)}/latest/meta?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { cache: "no-cache", headers: { accept: "application/json" } });
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw await apiError(res);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("seed metadata is not valid JSON");
  }
  const meta = parseRemoteSeedMeta(body);
  if (!meta) throw new Error("seed metadata is malformed (expected createdAt and sha256)");
  return meta;
}

export interface FetchedSeed {
  archive: WorkspaceArchive;
  raw: string;
  version?: string;
  sha256: string;
  size: number;
  meta: RemoteSeedMeta | null;
}

/** One seed on the shelf, as listed by `GET /{account}/seeds`. */
export interface ListedSeed {
  name: string;
  /** Newest version label the service resolved, when it publishes one. */
  latest?: string;
  /** Version labels, newest first, when the service lists them. */
  versions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate a seeds-listing payload. The documented shape lists version labels
 * as strings; entries with unusable names are dropped so one bad row cannot
 * hide the whole shelf from the picker.
 */
export function parseSeedList(raw: unknown): ListedSeed[] {
  if (!isRecord(raw)) throw new Error("seed list is malformed (expected a JSON object)");
  if (!Array.isArray(raw.seeds)) throw new Error("seed list is malformed (expected a seeds array)");
  const seen = new Set<string>();
  const seeds: ListedSeed[] = [];
  for (const entry of raw.seeds) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const name = entry.name.trim();
    if (!isValidSeedName(name) || seen.has(name)) continue;
    seen.add(name);
    const latest =
      typeof entry.latest === "string" && entry.latest.trim() ? entry.latest.trim() : undefined;
    const versions = Array.isArray(entry.versions)
      ? entry.versions
          .filter((version): version is string => typeof version === "string")
          .map((version) => version.trim())
          .filter(Boolean)
      : [];
    seeds.push(latest ? { name, latest, versions } : { name, versions });
  }
  return seeds.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List the seeds under an account (read scope). This is what the new-workspace
 * picker enumerates; `/latest` alone can only read a name the caller already
 * knows.
 */
export async function listSeeds(
  service: SwapService,
  account: string,
): Promise<ListedSeed[]> {
  const key = requireKey(service, "read");
  const url = `${apiBase(service)}/${encodeURIComponent(account)}/seeds?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { cache: "no-cache", headers: { accept: "application/json" } });
  if (!res.ok) throw await apiError(res);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("seed list is not valid JSON");
  }
  return parseSeedList(body);
}

/**
 * Download a seed's latest archive. A configured read key is used when
 * present; without one the request goes out anonymously, which only succeeds
 * while the newest version is public (the service answers 401 otherwise).
 * Verifies the bytes against the service's sha when it advertises one — from
 * `/latest/meta` when keyed, or the response `ETag` when it is not — and never
 * trusts a mismatched body.
 *
 * Returns null only when `ifNoneMatch` matched: the caller's copy is current
 * and no archive was transferred (HTTP 304).
 */
export interface FetchLatestSeedOptions {
  /** Send `If-None-Match` (a raw SHA-256 or ETag) to make an unchanged check cheap. */
  ifNoneMatch?: string;
}

export async function fetchLatestSeed(
  service: SwapService,
  account: string,
  seedName: string,
  opts: FetchLatestSeedOptions = {},
): Promise<FetchedSeed | null> {
  // A 2.5 MB archive is the most likely victim of a resumed/suspended
  // connection. Retry the whole read once when the transport truncates it.
  return retryTransient(() => fetchLatestSeedOnce(service, account, seedName, opts));
}

async function fetchLatestSeedOnce(
  service: SwapService,
  account: string,
  seedName: string,
  opts: FetchLatestSeedOptions = {},
): Promise<FetchedSeed | null> {
  const key = readKeyOf(service);
  const base = `${apiBase(service)}/${encodeURIComponent(account)}/${encodeURIComponent(seedName)}/latest`;
  const headers: Record<string, string> = { accept: "application/json" };
  const known = opts.ifNoneMatch?.trim();
  if (known) {
    headers["if-none-match"] = /^(?:W\/)?"/.test(known) ? known : `"${known.replace(/^"|"$/g, "")}"`;
  }
  const [res, keyedMeta] = await Promise.all([
    fetch(key ? `${base}?key=${encodeURIComponent(key)}` : base, { cache: "no-cache", headers }),
    key ? fetchLatestSeedMeta(service, account, seedName).catch(() => null) : Promise.resolve(null),
  ]);
  if (res.status === 304) return null;
  if (!res.ok) {
    if (res.status === 401 && !key) {
      throw new Error(
        "the newest seed version isn't public — ask the publisher to make it public, or add a read key in Sync… → BobSwap…",
      );
    }
    throw await apiError(res);
  }
  const raw = await res.text();
  const bytes = encoder.encode(raw);
  const sha256 = await sha256HexBytes(bytes);
  // `/latest/meta` stays key-gated; public downloads still advertise their
  // exact hash in ETag, which is enough to verify an anonymous archive.
  const announced = keyedMeta?.sha256 ?? sha256FromEtag(res.headers.get("etag"));
  if (announced && announced.toLowerCase() !== sha256) {
    throw new Error("seed download failed its checksum — try again or republish the seed");
  }
  let archive: WorkspaceArchive;
  try {
    archive = JSON.parse(raw) as WorkspaceArchive;
  } catch {
    throw new Error("seed download is not valid JSON");
  }
  const meta: RemoteSeedMeta | null =
    keyedMeta ??
    (typeof archive.createdAt === "string" && !Number.isNaN(Date.parse(archive.createdAt))
      ? {
          version: 1,
          createdAt: archive.createdAt,
          fileCount: archive.files.length,
          size: bytes.length,
          sha256,
        }
      : null);
  return {
    archive,
    raw,
    version:
      res.headers.get("x-seed-version") ??
      keyedMeta?.seed_id_and_version ??
      (sha256FromEtag(res.headers.get("etag")) ? sha256.slice(0, 12) : undefined),
    sha256,
    size: bytes.length,
    meta,
  };
}

interface LatestSeedHead {
  meta: RemoteSeedMeta;
  version?: string;
  sha256?: string;
}

/**
 * Read the newest version's freshness record with a bodyless HEAD request.
 * BobSwap exposes the archive's ETag, version label and content length on
 * `/latest`, so a keyless probe does not need to download the whole archive.
 * Returns null when the service does not advertise enough to decide (an older
 * deployment, or a 405); the caller then falls back to the archive GET.
 */
async function fetchLatestSeedHead(
  service: SwapService,
  account: string,
  seedName: string,
): Promise<LatestSeedHead | null> {
  const key = readKeyOf(service);
  const base = `${apiBase(service)}/${encodeURIComponent(account)}/${encodeURIComponent(seedName)}/latest`;
  const url = key ? `${base}?key=${encodeURIComponent(key)}` : base;
  const res = await retryTransient(() =>
    fetch(url, { method: "HEAD", cache: "no-cache", headers: { accept: "application/json" } }),
  );
  if (res.status === 304) return null;
  if (res.status === 405 || res.status === 501) return null;
  if (!res.ok) {
    if (res.status === 401 && !key) {
      throw new Error(
        "the newest seed version isn't public — ask the publisher to make it public, or add a read key in Sync… → BobSwap…",
      );
    }
    throw await apiError(res);
  }
  const version = res.headers.get("x-seed-version") ?? undefined;
  const sha256 = sha256FromEtag(res.headers.get("etag"));
  const fromVersion = version ? seedVersionCreatedAt(version) : null;
  const lastModified = res.headers.get("last-modified");
  const createdAt =
    fromVersion ??
    (lastModified && !Number.isNaN(Date.parse(lastModified))
      ? new Date(lastModified).toISOString()
      : null);
  if (!createdAt) return null;
  const length = Number(res.headers.get("content-length"));
  return {
    meta: {
      version: 1,
      createdAt,
      sha256,
      size: Number.isFinite(length) && length > 0 ? length : undefined,
      seed_id_and_version: version,
    },
    version,
    sha256,
  };
}

export interface LatestSeedProbe {
  /** Freshness record; synthesized from `/latest` headers on the keyless path. */
  meta: RemoteSeedMeta;
  version?: string;
  sha256?: string;
  /** True when the newest version was readable without any key. */
  keyless: boolean;
}

/**
 * Cheap newest-version check. With a read key it asks `/latest/meta`; without
 * one it asks for `/latest` headers only, so an unchanged public archive costs
 * one bodyless request instead of a multi-megabyte download. Returns null when
 * the advertised hash still matches the caller's copy.
 */
export async function probeLatestSeed(
  service: SwapService,
  account: string,
  seedName: string,
  knownSha?: string,
): Promise<LatestSeedProbe | null> {
  const keyed = readKeyOf(service);
  if (keyed) {
    const meta = await fetchLatestSeedMeta(service, account, seedName);
    if (meta) {
      return { meta, version: meta.seed_id_and_version, sha256: meta.sha256, keyless: false };
    }
  }
  // Keyless (or a keyed service with no `/latest/meta`): ask for headers only.
  // The archive can be several megabytes; a tab-resume probe must not fetch it.
  const head = await fetchLatestSeedHead(service, account, seedName);
  if (head) {
    const local = knownSha?.trim().toLowerCase();
    if (local && head.sha256 && head.sha256 === local) return null;
    return { ...head, keyless: !keyed };
  }
  // Older/custom services: fall back to the archive download (which sends
  // If-None-Match so an unchanged copy still costs a 304).
  const fetched = await fetchLatestSeed(service, account, seedName, { ifNoneMatch: knownSha });
  if (!fetched) return null;
  if (!fetched.meta) throw new Error("seed archive is missing a valid createdAt");
  return {
    meta: fetched.meta,
    version: fetched.version,
    sha256: fetched.sha256,
    keyless: !keyed,
  };
}

export interface PublishedSeed {
  version: string;
  sha256: string;
  createdAt: string;
  size: number;
  fileCount: number;
}

/**
 * Upload the active workspace as a new seed version. The version segment is
 * content-addressed (`<sha12>-<compact createdAt>`) so the service can verify
 * it against the body and re-uploads stay idempotent.
 */
export async function publishSeed(
  service: SwapService,
  account: string,
  seedName: string,
  archive: WorkspaceArchive,
): Promise<PublishedSeed> {
  const key = requireKey(service, "upload");
  const raw = JSON.stringify(archive);
  const bytes = encoder.encode(raw);
  const sha256 = await sha256HexBytes(bytes);
  const createdAt = archive.createdAt || new Date().toISOString();
  const version = seedVersionTag(sha256, createdAt);
  const url =
    `${apiBase(service)}/${encodeURIComponent(account)}/${encodeURIComponent(seedName)}/` +
    encodeURIComponent(version);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: raw,
  });
  if (!res.ok) throw await apiError(res);
  return { version, sha256, createdAt, size: bytes.length, fileCount: archive.files.length };
}
