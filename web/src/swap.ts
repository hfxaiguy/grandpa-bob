/**
 * BobSwap client: the seed shelf and the zero-storage workspace relay.
 *
 * Server contract (https://bobswap.hfxaiguy.com/docs/agents):
 *   GET  /api/v1/{account}/{seed}/latest/meta?key=…   → tiny freshness record
 *   GET  /api/v1/{account}/{seed}/latest?key=…        → archive JSON (ETag/304)
 *   PUT  /api/v1/{account}/{seed}/{id-and-version}    → upload (Bearer, upload scope)
 *   POST /api/v1/relay/channels                       → pair a share (Bearer, read scope)
 *   POST /api/v1/relay/channels/{id}/join             → join with a pairing code
 *   GET/POST/DELETE /relay/channels/{id}[/status]     → role-token control plane
 *
 * Relay content travels over an ephemeral Supabase broadcast topic. Broadcast
 * event: `relay`; payloads: chunk/ack/complete/abort (see RelayMessage).
 * Chunks are 192 KiB slices → ~256 KiB base64, acknowledged individually,
 * verified with SHA-256. Pairing codes must never appear in URLs.
 */
import type { WorkspaceArchive } from "./workspace-transfer";
import { parseSeedMeta, type SeedMeta } from "./seed-version";
import { isValidSeedName, seedVersionTag } from "./profiles";
import type { DeviceIdentity } from "./device-keys";

// ── service configuration (localStorage) ─────────────────────────────────

export interface SwapService {
  /** REST base, e.g. `https://bobswap.example.com`. Keys route to /api/v1. */
  baseUrl: string;
  /** Supabase URL for Realtime (defaults to baseUrl). */
  realtimeUrl?: string;
  /** Supabase publishable/anon key — needed only for the relay transport. */
  realtimeKey?: string;
  /** Account namespace the keys belong to (BobSwap keys are account-bound). */
  account?: string;
  /** Read-scope BobSwap key (seeds + opening relay channels). */
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

/**
 * Public Supabase endpoint used for the ephemeral broadcast topics. The
 * publishable key is already shipped in the BobSwap dashboard bundle; it
 * grants only public broadcast access, never API scopes.
 */
export const DEFAULT_SWAP_REALTIME_URL = "https://iqrsezxlgcfqxaiytsjj.supabase.co";
export const DEFAULT_SWAP_REALTIME_KEY = "sb_publishable_Q_TUej1amQlqMTQ7YRJsRA_eo7L_2qs";

/** A keyless default entry: enough to open the dialogs and show what to add. */
export function defaultSwapService(): SwapService {
  return {
    baseUrl: DEFAULT_SWAP_SERVICE_URL,
    realtimeUrl: DEFAULT_SWAP_REALTIME_URL,
    realtimeKey: DEFAULT_SWAP_REALTIME_KEY,
  };
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
const decoder = new TextDecoder();

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function bytesFromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

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
 * Download a seed's latest archive. Verifies the bytes against the service's
 * sha when it advertises one; never trusts a mismatched body.
 */
export async function fetchLatestSeed(
  service: SwapService,
  account: string,
  seedName: string,
): Promise<FetchedSeed> {
  const key = requireKey(service, "read");
  const base = `${apiBase(service)}/${encodeURIComponent(account)}/${encodeURIComponent(seedName)}/latest`;
  const [res, meta] = await Promise.all([
    fetch(`${base}?key=${encodeURIComponent(key)}`, { cache: "no-cache" }),
    fetchLatestSeedMeta(service, account, seedName).catch(() => null),
  ]);
  if (!res.ok) throw await apiError(res);
  const raw = await res.text();
  const bytes = encoder.encode(raw);
  const sha256 = await sha256HexBytes(bytes);
  const announced = meta?.sha256;
  if (announced && announced.toLowerCase() !== sha256) {
    throw new Error("seed download failed its checksum — try again or republish the seed");
  }
  let archive: WorkspaceArchive;
  try {
    archive = JSON.parse(raw) as WorkspaceArchive;
  } catch {
    throw new Error("seed download is not valid JSON");
  }
  return {
    archive,
    raw,
    version: res.headers.get("x-seed-version") ?? meta?.seed_id_and_version,
    sha256,
    size: bytes.length,
    meta,
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

// ── relay: channel setup ─────────────────────────────────────────────────

export interface RelayChannelInfo {
  channelId: string;
  code: string;
  /** Exact topic returned by the service; never reconstruct it. */
  realtimeChannel: string;
  expiresAt?: string;
  visualCheck?: string;
  /** Role token for control-plane GET/status/DELETE (never in a URL). */
  ownerToken?: string;
}

export interface RelayJoinInfo {
  channelId: string;
  /** Exact topic returned by the service; never reconstruct it. */
  realtimeChannel: string;
  mode: string;
  size: number;
  sha256: string;
  ownerDevice: { name?: string; public_key?: string };
  visualCheck?: string;
  /** Role token for control-plane GET/status/DELETE (never in a URL). */
  recipientToken?: string;
}

export async function createRelayChannel(
  service: SwapService,
  archive: WorkspaceArchive,
  device: DeviceIdentity,
): Promise<{ info: RelayChannelInfo; raw: string; sha256: string; size: number }> {
  const key = requireKey(service, "read");
  const raw = JSON.stringify(archive);
  const bytes = encoder.encode(raw);
  const sha256 = await sha256HexBytes(bytes);
  const res = await fetch(`${apiBase(service)}/relay/channels`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      mode: "copy",
      size: bytes.length,
      sha256,
      file_count: archive.files.length,
      owner_device: { name: device.name, public_key: device.publicKeyB64 },
    }),
  });
  if (!res.ok) throw await apiError(res);
  const body = (await res.json()) as Record<string, unknown>;
  const channelId = typeof body.channel_id === "string" ? body.channel_id : "";
  const code = typeof body.pairing_code === "string" ? body.pairing_code : "";
  const realtimeChannel = typeof body.realtime_channel === "string" ? body.realtime_channel : "";
  if (!channelId || !code || !realtimeChannel) {
    throw new Error("BobSwap returned an incomplete channel");
  }
  return {
    raw,
    sha256,
    size: bytes.length,
    info: {
      channelId,
      code,
      realtimeChannel,
      expiresAt: typeof body.expires_at === "string" ? body.expires_at : undefined,
      visualCheck: typeof body.visual_check === "string" ? body.visual_check : undefined,
      ownerToken: typeof body.owner_join_token === "string" ? body.owner_join_token : undefined,
    },
  };
}

export async function joinRelayChannel(
  service: SwapService,
  channelId: string,
  code: string,
  device: DeviceIdentity,
): Promise<RelayJoinInfo> {
  const res = await fetch(
    `${apiBase(service)}/relay/channels/${encodeURIComponent(channelId)}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairing_code: code,
        device: { name: device.name, public_key: device.publicKeyB64 },
      }),
    },
  );
  if (!res.ok) throw await apiError(res);
  const raw = (await res.json()) as Record<string, unknown>;
  const rawOwner =
    raw.owner_device && typeof raw.owner_device === "object"
      ? (raw.owner_device as Record<string, unknown>)
      : raw.ownerDevice && typeof raw.ownerDevice === "object"
        ? (raw.ownerDevice as Record<string, unknown>)
        : {};
  const realtimeChannel = typeof raw.realtime_channel === "string" ? raw.realtime_channel : "";
  if (!realtimeChannel) throw new Error("BobSwap returned no realtime channel");
  return {
    channelId: typeof raw.channel_id === "string" ? raw.channel_id : channelId,
    realtimeChannel,
    mode: typeof raw.mode === "string" ? raw.mode : "copy",
    size: typeof raw.size === "number" ? raw.size : 0,
    sha256: typeof raw.sha256 === "string" ? raw.sha256 : "",
    ownerDevice: {
      name: typeof rawOwner.name === "string" ? rawOwner.name : "the other device",
      public_key:
        typeof rawOwner.public_key === "string"
          ? rawOwner.public_key
          : typeof rawOwner.publicKey === "string"
            ? rawOwner.publicKey
            : "",
    },
    visualCheck: typeof raw.visual_check === "string" ? raw.visual_check : undefined,
    recipientToken:
      typeof raw.recipient_join_token === "string" ? raw.recipient_join_token : undefined,
  };
}

// ── relay: control plane (role tokens) ───────────────────────────────────

/** Best-effort control-plane call; null means gone/expired/invalid token. */
async function relayControl(
  service: SwapService,
  channelId: string,
  token: string | undefined,
  method: "GET" | "POST" | "DELETE",
  suffix = "",
  body?: unknown,
): Promise<Response | null> {
  if (!token) return null;
  try {
    const res = await fetch(
      `${apiBase(service)}/relay/channels/${encodeURIComponent(channelId)}${suffix}`,
      {
        method,
        headers:
          body === undefined
            ? { authorization: `Bearer ${token}` }
            : { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

interface RelayChannelState {
  status?: string;
  visual_check?: string;
  recipient_device?: { name?: string; public_key?: string };
  progress?: { n?: number; of?: number };
}

async function fetchRelayState(
  service: SwapService,
  channelId: string,
  token: string | undefined,
): Promise<RelayChannelState | null> {
  const res = await relayControl(service, channelId, token, "GET");
  if (!res) return null;
  try {
    return (await res.json()) as RelayChannelState;
  } catch {
    return null;
  }
}

/** Report a lifecycle state; terminal states delete the pairing metadata. */
async function reportStatus(
  service: SwapService,
  channelId: string,
  token: string | undefined,
  status: "streaming" | "completed" | "failed" | "aborted",
  extra: { progress?: { n: number; of: number }; reason?: string } = {},
): Promise<void> {
  await relayControl(service, channelId, token, "POST", "/status", { status, ...extra });
}

/** Abort/delete the pairing (used on cancellation and integrity failures). */
async function closeRelayChannel(
  service: SwapService,
  channelId: string,
  token: string | undefined,
): Promise<void> {
  await relayControl(service, channelId, token, "DELETE");
}

// ── relay: ephemeral transport ───────────────────────────────────────────

/**
 * Broadcast payloads documented by the service. The event name is `relay` and
 * messages are transient: clients must subscribe before streaming and handle
 * duplicates/retransmits themselves.
 */
export type RelayMessage =
  | { t: "chunk"; i: number; of: number; b64: string }
  | { t: "ack"; i: number }
  | { t: "complete"; sha256_ok: boolean }
  | { t: "abort"; reason?: string };

interface RealtimeLink {
  send(message: RelayMessage): Promise<void>;
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Supabase endpoint for the public broadcast topics (safe to ship publicly). */
function realtimeConfig(service: SwapService): { url: string; key: string } {
  const isDefault = service.baseUrl === DEFAULT_SWAP_SERVICE_URL;
  return {
    url:
      service.realtimeUrl ||
      (isDefault ? DEFAULT_SWAP_REALTIME_URL : service.baseUrl),
    key: service.realtimeKey || (isDefault ? DEFAULT_SWAP_REALTIME_KEY : ""),
  };
}

async function connectRealtime(
  service: SwapService,
  channelName: string,
  onMessage: (message: RelayMessage) => void,
  onStatus: (status: string) => void,
): Promise<RealtimeLink> {
  const { url, key } = realtimeConfig(service);
  if (!key) {
    throw new Error(
      "no realtime key is configured for this BobSwap service — add the Supabase " +
        "publishable key in the BobSwap… settings",
    );
  }
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const channel = client.channel(channelName, {
    config: { broadcast: { self: false } },
  });
  channel.on("broadcast", { event: "relay" }, (event) => {
    onMessage(event.payload as RelayMessage);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("realtime connection timed out")), 20_000);
    channel.subscribe((status) => {
      onStatus(status);
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`realtime channel failed (${status})`));
      }
    });
  });

  return {
    async send(message) {
      const result = await channel.send({
        type: "broadcast",
        event: "relay",
        payload: message,
      });
      if (result !== "ok") throw new Error(`realtime send failed (${result})`);
    },
    async close() {
      await client.removeChannel(channel).catch(() => undefined);
      try {
        client.realtime.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

// ── relay: sender ────────────────────────────────────────────────────────

export interface RelayProgress {
  phase: "offered" | "waiting" | "sending" | "verifying" | "done" | "error";
  sent: number;
  total: number;
  message: string;
  check?: string;
  peer?: string;
  code?: string;
}

export interface SendWorkspaceOptions {
  service: SwapService;
  archive: WorkspaceArchive;
  device: DeviceIdentity;
  onChannel: (info: RelayChannelInfo) => void;
  onProgress: (progress: RelayProgress) => void;
  signal?: AbortSignal;
}

const CHUNK_INPUT_BYTES = 192 * 1024;
const ACK_TIMEOUT_MS = 8_000;

/** Reject as soon as `signal` aborts (relay waits must be cancellable). */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Offer a workspace copy and stream it once the other device joins. */
export async function sendWorkspace(options: SendWorkspaceOptions): Promise<void> {
  const { service, archive, device, onChannel, onProgress, signal } = options;
  const { info, raw, sha256, size } = await createRelayChannel(service, archive, device);
  onChannel(info);
  onProgress({
    phase: "offered",
    sent: 0,
    total: size,
    code: info.code,
    message: "waiting for the other device to join…",
    check: info.visualCheck,
  });

  const bytes = encoder.encode(raw);
  const total = Math.ceil(bytes.length / CHUNK_INPUT_BYTES) || 1;
  let check = info.visualCheck;
  let peer = "";
  let terminal: "completed" | "failed" | "aborted" = "aborted";
  let failure = "";

  let settle!: (ok: boolean) => void;
  let fail!: (err: Error) => void;
  const completion = new Promise<boolean>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const ackWaiters = new Map<number, () => void>();

  const link = await connectRealtime(
    service,
    info.realtimeChannel,
    (message) => {
      switch (message.t) {
        case "ack":
          ackWaiters.get(message.i)?.();
          break;
        case "complete":
          settle(message.sha256_ok === true);
          break;
        case "abort":
          fail(new Error(message.reason || "the other device aborted the transfer"));
          break;
        default:
          break;
      }
    },
    (status) => {
      if (status === "SUBSCRIBED") peer = peer || "connected";
    },
  );

  try {
    // Wait until the service shows the paired recipient. This doubles as the
    // subscription race guard: public broadcast has no replay.
    if (info.ownerToken) {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("cancelled");
        const state = await fetchRelayState(service, info.channelId, info.ownerToken);
        if (!state) throw new Error("the pairing expired or was cancelled");
        if (state.visual_check) check = state.visual_check;
        if (state.recipient_device) {
          peer = state.recipient_device.name || "recipient";
          if (!check && state.recipient_device.public_key) {
            const digest = await sha256HexText(
              `rv|${device.publicKeyB64}|${state.recipient_device.public_key}|${size}`,
            );
            check = digest.slice(0, 4).toUpperCase();
          }
        }
        if (check && state.recipient_device) break;
        await sleep(1_000);
      }
      if (!check || !peer) throw new Error("the other device did not join in time");
    }
    onProgress({
      phase: "waiting",
      sent: 0,
      total: size,
      code: info.code,
      check,
      peer,
      message: "devices verified — starting transfer…",
    });

    // Let the recipient finish subscribing; chunks are not replayed.
    await sleep(750);
    terminal = "failed";
    await reportStatus(service, info.channelId, info.ownerToken, "streaming", {
      progress: { n: 0, of: total },
    });

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new Error("cancelled");
      const slice = bytes.subarray(i * CHUNK_INPUT_BYTES, (i + 1) * CHUNK_INPUT_BYTES);
      const frame: RelayMessage = { t: "chunk", i, of: total, b64: base64FromBytes(slice) };

      let attempts = 0;
      for (;;) {
        const acked = new Promise<void>((resolve) => ackWaiters.set(i, resolve));
        await link.send(frame);
        try {
          await timeout(abortable(acked, signal), ACK_TIMEOUT_MS, `chunk ${i + 1} was not acknowledged`);
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 3) throw err; // initial send + two retries
        } finally {
          ackWaiters.delete(i);
        }
      }

      onProgress({
        phase: "sending",
        sent: Math.min(size, (i + 1) * CHUNK_INPUT_BYTES),
        total: size,
        code: info.code,
        check,
        peer,
        message: `sent ${i + 1}/${total}`,
      });
    }

    terminal = "aborted";
    onProgress({
      phase: "verifying",
      sent: size,
      total: size,
      code: info.code,
      check,
      peer,
      message: "waiting for the checksum…",
    });
    const ok = await timeout(
      abortable(completion, signal),
      60_000,
      "the other device did not confirm the checksum",
    );
    if (!ok) throw new Error("the receiving device reported a checksum mismatch");

    terminal = "completed";
    onProgress({
      phase: "done",
      sent: size,
      total: size,
      code: info.code,
      check,
      peer,
      message: "workspace delivered",
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    onProgress({
      phase: "error",
      sent: 0,
      total: size,
      code: info.code,
      check,
      peer,
      message: failure,
    });
    throw err;
  } finally {
    // Terminal status deletes the pairing metadata; 404 is fine if the
    // receiver already closed it.
    await reportStatus(service, info.channelId, info.ownerToken, terminal, {
      progress: { n: terminal === "completed" ? total : 0, of: total },
      reason: terminal === "completed" ? undefined : failure.slice(0, 60) || undefined,
    });
    await link.close();
  }
}

// ── relay: receiver ──────────────────────────────────────────────────────

export interface ReceiveWorkspaceOptions {
  service: SwapService;
  channelId: string;
  code: string;
  device: DeviceIdentity;
  onProgress: (progress: RelayProgress) => void;
  signal?: AbortSignal;
}

export interface ReceivedWorkspace {
  archive: WorkspaceArchive;
  sha256: string;
  size: number;
  ownerName: string;
  visualCheck?: string;
}

/**
 * Join a share and reassemble the archive in memory.
 *
 * The visual check both humans compare is the first four uppercase hex
 * characters of `sha256("rv|" + ownerKey + "|" + recipientKey + "|" + size)`.
 * The join response normally carries it; derivation is only a fallback.
 */
export async function receiveWorkspace(
  options: ReceiveWorkspaceOptions,
): Promise<ReceivedWorkspace> {
  const { service, channelId, code, device, onProgress, signal } = options;
  const joined = await joinRelayChannel(service, channelId, code, device);

  const ownerKey = joined.ownerDevice?.public_key ?? "";
  const derived = await sha256HexText(`rv|${ownerKey}|${device.publicKeyB64}|${joined.size}`);
  const rawCheck = (joined.visualCheck || derived).toUpperCase().replace(/[^0-9A-Z]/g, "");
  const visualCheck = rawCheck.length >= 4 ? rawCheck.slice(0, 4) : derived.slice(0, 4).toUpperCase();
  const ownerName = joined.ownerDevice?.name || "the other device";
  const channel = joined.channelId || channelId;

  const received = new Map<number, Uint8Array>();
  let expected = 0;
  let settled = false;
  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const progress = (message: string, sent = 0): void => {
    onProgress({
      phase: "sending",
      sent,
      total: joined.size,
      check: visualCheck,
      peer: ownerName,
      message,
    });
  };

  const link = await connectRealtime(
    service,
    joined.realtimeChannel,
    (message) => {
      if (message.t === "chunk") {
        if (settled) return;
        received.set(message.i, bytesFromBase64(message.b64));
        expected = Math.max(expected, message.of);
        const bytes = [...received.values()].reduce((sum, part) => sum + part.length, 0);
        progress(`received ${received.size}/${expected} chunks`, bytes);
        void link.send({ t: "ack", i: message.i });

        if (expected > 0 && received.size >= expected) {
          let complete = true;
          for (let i = 0; i < expected; i++) {
            if (!received.has(i)) {
              complete = false;
              break;
            }
          }
          if (complete) {
            settled = true;
            resolveDone();
          }
        }
      } else if (message.t === "abort") {
        rejectDone(new Error(message.reason || "the other device aborted the transfer"));
      }
    },
    (status) => {
      if (status === "SUBSCRIBED") progress("connected — waiting for the first chunk…");
    },
  );

  try {
    await reportStatus(service, channel, joined.recipientToken, "streaming", {
      progress: { n: 0, of: expected || 1 },
    });
    await timeout(abortable(done, signal), 300_000, "the transfer did not finish in time");
    progress("checking the archive…");

    if (received.size !== expected) {
      await link.send({ t: "complete", sha256_ok: false });
      await link.send({ t: "abort", reason: "missing chunks" });
      throw new Error(`transfer incomplete (${received.size}/${expected} chunks)`);
    }

    let size = 0;
    for (let i = 0; i < expected; i++) {
      const part = received.get(i);
      if (!part) {
        await link.send({ t: "complete", sha256_ok: false });
        throw new Error(`transfer incomplete (chunk ${i} missing)`);
      }
      size += part.length;
    }
    const assembled = new Uint8Array(size);
    let offset = 0;
    for (let i = 0; i < expected; i++) {
      const part = received.get(i)!;
      assembled.set(part, offset);
      offset += part.length;
    }

    const sha256 = await sha256HexBytes(assembled);
    const ok = sha256 === joined.sha256.toLowerCase();
    await link.send({ t: "complete", sha256_ok: ok });
    if (!ok) {
      await link.send({ t: "abort", reason: "integrity" });
      throw new Error("checksum mismatch — the copy was corrupted in transit");
    }

    const raw = decoder.decode(assembled);
    let archive: WorkspaceArchive;
    try {
      archive = JSON.parse(raw) as WorkspaceArchive;
    } catch {
      throw new Error("the transferred workspace is not valid JSON");
    }
    await reportStatus(service, channel, joined.recipientToken, "completed", {
      progress: { n: expected, of: expected },
    });
    onProgress({
      phase: "done",
      sent: assembled.length,
      total: joined.size,
      check: visualCheck,
      peer: ownerName,
      message: `received ${archive.files.length} files`,
    });
    return { archive, sha256, size: assembled.length, ownerName, visualCheck };
  } catch (err) {
    await closeRelayChannel(service, channel, joined.recipientToken);
    throw err;
  } finally {
    await link.close();
  }
}
