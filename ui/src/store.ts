/** App state + actions, shared by every component. A module-level Solid store
 *  keeps the tree simple: one screen follows one session, exactly like the old
 *  chat page, but the stream is split per app. */
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { getJSON, postJSON, postForm, openEventStream } from "./api";
import type { AppInfo, PatternInfo, Provenance, RefTarget, SessionInfo, Slot, Turn } from "./types";

/** Events kept per turn in the live store. The full trace lives in the run log
 *  (`read_runs`); the UI only ever shows a tail, and an unbounded array is what
 *  froze the tab during a big run. */
const MAX_TURN_EVENTS = 500;

/** Trim every turn's event list to the live window (used on refresh + stream). */
function capEvents(turns: Turn[]): Turn[] {
  return turns.map((t) =>
    t.events && t.events.length > MAX_TURN_EVENTS ? { ...t, events: t.events.slice(-MAX_TURN_EVENTS) } : t,
  );
}

export interface Layout {
  order: string[];
  hidden: string[];
  expanded: string[];
  wide: string[];
  /** Tiles fixed in place (and the only ones whose manual order counts).
   *  Everything else floats to the top with recent activity. */
  pinned: string[];
  /** Board tiles the bot raised on its own (not a manual open or a profile
   *  exception). Only these are auto-closed once no turn has used them for
   *  `AUTO_CLOSE_TURNS` turns; touching the rail clears the entry. */
  autoRaised: string[];
  /** Sub-apps opened inside their parent, in the order they were opened —
   *  the render order of the side-by-side strip, so a running chat never
   *  jumps. Parks (closing) removes the entry. */
  subsOpen: string[];
  /** Tiles whose memory panel is collapsed. Memory is open by default on a
   *  desktop, so this is the exception list (like hidden) — it survives reloads
   *  because tiles remount on every session switch. */
  memClosed: string[];
  /** Tiles whose memory panel was explicitly opened where the default is
   *  collapsed (phone width). An explicit choice beats both lists. */
  memOpen: string[];
}

export interface UiState {
  /** Boot finished: the catalogs and the session are loaded and the live
   *  stream is open. The app shell shows its splash until this flips. */
  ready: boolean;
  /** What boot is doing right now ("restoring your last session…"). Shown on
   *  the splash, so a slow load reads as progress instead of a stuck page. */
  bootStatus: string;
  /** Boot progress 0–100. Step-weighted (each fetch phase has a fixed share),
   *  not a byte counter — the point is honest movement, not exact timing. */
  bootProgress: number;
  apps: AppInfo[];
  sessions: SessionInfo[];
  active: string | null;
  label: string;
  follow: boolean;
  patterns: PatternInfo[];
  pattern: string;
  slots: Slot[];
  models: Record<string, string>;
  /** The in-tab registry is still the auto-generated mock one (standalone). */
  mockOnly: boolean;
  turns: Turn[];
  awaiting: string | null;
  memory: Record<string, Record<string, unknown>>;
  /** The conversation `memory` was fetched for. The panel names it, so a
   *  resumed conversation reads as resumed instead of as a value that
   *  survived a session switch. Null until the first fetch lands / no session. */
  memorySession: string | null;
  /** The active conversation had history when it was opened (a resume), not a
   *  freshly minted chat. Display only. */
  sessionResumed: boolean;
  connected: boolean;
  /** An admin server is behind this page (probed at boot via
   *  /api/capabilities). Server-only controls — follow-the-phone, admin
   *  models — stay visible but disabled when false. */
  adminOnline: boolean;
  /** This page runs the in-browser backend (OPFS storage), not the admin's
   *  chat API. The Telegram bridge and the one-shot push both target the
   *  local channel process instead. */
  browserMode: boolean;
  /** The two-way bridge is switched on for this tab (localStorage). */
  bridgeOn: boolean;
  toast: string;
  toastErr: boolean;
  /** The most recent failure (a failed turn or a failed model call), shown
   *  as a dismissible banner. */
  lastError: { title: string; text: string } | null;
  /** A hidden tile whose app is active but could not raise because both app
   *  seats are taken; its rail square pulses until opened (or the pulse
   *  times out). */
  raiseDenied: string | null;
  /** The phone's lifted tile: tapping a tile header brings that one tile to the
   *  front as a board-wide overlay above the grid and the trunk. Not persisted;
   *  tapping the header again (or parking the tile) puts it back. */
  front: string | null;
  layout: Layout;
  /** The event stream is shown. Persisted; on a small screen it starts hidden
   *  and folds into a bottom sheet when opened. */
  streamOpen: boolean;
  /** Last time each app was seen doing something (epoch ms). Drives the
   *  most-recent-first order of unpinned tiles; derived from the turns, not
   *  persisted. */
  activity: Record<string, number>;
  /** Show emits tagged `machine` in the app chat bubbles. On by default
   *  (faded) so tree input and waiting notes stay discoverable; the toggle
   *  lets the user hide them. */
  showMachine: boolean;
}

/** The active profile's name (localStorage is set before the app mounts). */
function storedProfileName(): string {
  try {
    return localStorage.getItem("bob:profile") || "default";
  } catch {
    return "default";
  }
}

/** Layouts are per profile: hidden tiles in one workspace must not leak into
 *  another. The old unscoped key still seeds the default profile. */
const LEGACY_LAYOUT_KEY = "gpb.tiled.layout";
const LAYOUT_KEY = `gpb.tiled.layout:${storedProfileName()}`;
/** Apps a brand-new session keeps on the board, besides trunk (the
 *  conversation itself) when the profile has no explicit exception list. Empty:
 *  a fresh chat opens on trunk alone, and active apps raise their tiles as
 *  they run (see `maybeRaiseTile`). */
const NEW_SESSION_KEEP: readonly string[] = [];
/** Board seats for auto-raised app tiles, beside trunk. The bot opens a tile
 *  when its app becomes active; with both seats taken the app waits in the
 *  rail (its square pulses) instead of evicting a tile the user may be
 *  reading. Manual opens from the rail are never capped. */
const AUTO_RAISE_SEATS = 2;
/** Turns an auto-raised tile may go unused before it parks again. The count
 *  includes the turn that just ended, so an app used in turn N closes at the
 *  end of turn N+2. Pinned tiles, manual opens and profile exceptions stay. */
const AUTO_CLOSE_TURNS = 2;
/** How long a denied raise keeps pulsing its rail square. */
const RAISE_DENIED_MS = 12_000;
const MACHINE_KEY = "gpb.showMachine";
const STREAM_KEY = "gpb.tiled.stream";
const BRIDGE_KEY = "bob:telegram-bridge";
/** Remembered linked chat (per profile) — the backend's offline relay target. */
const BRIDGE_CONV_KEY = "bob:telegram-bridge-conv";

/** Base URL of the storage bridge (the tab's STT pass-through target). */
const SERVER_KEY = "bob:storage-server";
const DEFAULT_SERVER = "http://127.0.0.1:8795";
function bridgeUrl(): string {
  try {
    const raw = localStorage.getItem(SERVER_KEY) ?? "";
    if (!raw) return DEFAULT_SERVER;
    return new URL(raw.includes("://") ? raw : `http://${raw}`).origin;
  } catch {
    return DEFAULT_SERVER;
  }
}

/** Base URL of the telegram channel (the tab's phone surface). */
const TELEGRAM_KEY = "bob:telegram-channel";
/** Shares the storage bridge's port (src/index.ts). */
const DEFAULT_TELEGRAM = "http://127.0.0.1:8795";
/** Pre-merge standalone channel port; saved settings migrate off it. */
const LEGACY_TELEGRAM = "http://127.0.0.1:8091";
function telegramChannelUrl(): string {
  try {
    const raw = localStorage.getItem(TELEGRAM_KEY) ?? "";
    if (!raw) return DEFAULT_TELEGRAM;
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`).origin;
    return url === LEGACY_TELEGRAM ? DEFAULT_TELEGRAM : url;
  } catch {
    return DEFAULT_TELEGRAM;
  }
}

/**
 * The profile id this page hosts — the same derivation the local backend
 * uses for mailbox claims. Workspaces always live in OPFS now; `?server=` /
 * the bridge URL only affects the desktop mirror, not the workspace id.
 */
function profileId(): string {
  let profile = "default";
  try {
    profile = localStorage.getItem("bob:profile") || "default";
  } catch {
    /* private mode */
  }
  return `opfs:${profile}`;
}

/** The mobile breakpoint. styles.css repeats the same width: at or below it
 *  the stream folds away by default and opens as a bottom sheet. */
export const SMALL_QUERY = "(max-width: 640px)";

/** Whether the viewport is currently phone-sized. Kept reactive so the toolbar
 *  (which folds stream/machine/session into settings there) and the tiles
 *  (whose memory defaults collapsed there) follow a resize without a reload. */
function detectSmall(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.(SMALL_QUERY).matches;
  } catch {
    return false;
  }
}
export const [smallScreen, setSmallScreen] = createSignal(detectSmall());

function loadBridge(): boolean {
  try {
    return localStorage.getItem(BRIDGE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadLayout(): Layout {
  try {
    let saved = localStorage.getItem(LAYOUT_KEY);
    if (saved === null && storedProfileName() === "default") {
      saved = localStorage.getItem(LEGACY_LAYOUT_KEY);
    }
    const raw = JSON.parse(saved || "null");
    if (raw && typeof raw === "object") {
      return {
        order: Array.isArray(raw.order) ? raw.order : [],
        hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
        expanded: Array.isArray(raw.expanded) ? raw.expanded : [],
        wide: Array.isArray(raw.wide) ? raw.wide : [],
        // A layout saved before pins existed (or a fresh one) starts with the
        // trunk fixed: the default is "trunk stays put, everything else flows".
        pinned: Array.isArray(raw.pinned) ? raw.pinned : ["trunk"],
        // A layout saved before auto-close existed knows nothing was auto-raised
        // by this tab, so it starts with an empty list (manual opens stay put).
        autoRaised: Array.isArray(raw.autoRaised) ? raw.autoRaised : [],
        // Sub-app tiles start parked (the square rail inside their parent), so
        // an empty list is the right migration for layouts saved before this.
        subsOpen: Array.isArray(raw.subsOpen) ? raw.subsOpen : [],
        // Memory panels start open on desktop; the closed list is the exception.
        memClosed: Array.isArray(raw.memClosed) ? raw.memClosed : [],
        // Explicit opens, needed where the phone-width default is collapsed.
        memOpen: Array.isArray(raw.memOpen) ? raw.memOpen : [],
      };
    }
  } catch {
    /* private mode / bad json */
  }
  return {
    order: [],
    hidden: [],
    expanded: [],
    wide: [],
    pinned: ["trunk"],
    autoRaised: [],
    subsOpen: [],
    memClosed: [],
    memOpen: [],
  };
}

/** Stream visibility: an explicit user choice, else open on desktop and closed
 *  on a phone (small screens reclaim the space by default). */
function loadStreamOpen(): boolean {
  try {
    const raw = localStorage.getItem(STREAM_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* private mode */
  }
  try {
    if (typeof window === "undefined") return true;
    return !window.matchMedia?.(SMALL_QUERY).matches;
  } catch {
    return true;
  }
}

function loadShowMachine(): boolean {
  try {
    return localStorage.getItem(MACHINE_KEY) !== "0";
  } catch {
    return true;
  }
}

export const [state, setState] = createStore<UiState>({
  ready: false,
  bootStatus: "starting…",
  bootProgress: 0,
  apps: [],
  sessions: [],
  active: null,
  label: "",
  follow: false,
  patterns: [],
  pattern: "",
  slots: [],
  models: {},
  mockOnly: false,
  turns: [],
  awaiting: null,
  memory: {},
  memorySession: null,
  sessionResumed: false,
  connected: false,
  adminOnline: true,
  browserMode: false,
  bridgeOn: loadBridge(),
  toast: "",
  toastErr: false,
  lastError: null,
  raiseDenied: null,
  front: null,
  layout: loadLayout(),
  streamOpen: loadStreamOpen(),
  activity: {},
  showMachine: loadShowMachine(),
});

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout));
  } catch {
    /* ignore */
  }
}

// ── ref:// inspector ─────────────────────────────────────────────────────
/** The ref handle open in the inspector, or null. Module-level so any text in
 *  the UI (a bubble, a log line, the provenance panel) can render a `ref://…`
 *  token as a link that opens the row it points at ("the handle IS the value"). */
export const [refView, setRefView] = createSignal<{ seq: number; path: string | null } | null>(null);
export function openRef(seq: number, path?: string | null): void {
  if (Number.isInteger(seq) && seq > 0) setRefView({ seq, path: path ?? null });
}
export function closeRef(): void {
  setRefView(null);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, err = false): void {
  setState({ toast: text, toastErr: err });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: "" }), 3200);
}

// ── loaders ─────────────────────────────────────────────────────────────

export async function refreshApps(): Promise<void> {
  try {
    const d = await getJSON<{ apps: AppInfo[] }>("/api/apps");
    setState("apps", d.apps);
    // The front layer is a seat in the catalog: a removed app cannot hold it.
    if (state.front && !d.apps.some((a) => a.name === state.front)) clearFront();
  } catch (e) {
    console.warn("apps:", e);
  }
}

export async function refreshPatterns(): Promise<void> {
  try {
    const d = await getJSON<{ current: string; patterns: PatternInfo[] }>("/api/pattern");
    setState({ patterns: d.patterns, pattern: d.current });
  } catch (e) {
    console.warn("patterns:", e);
  }
}

export async function refreshModels(): Promise<void> {
  try {
    const d = await getJSON<{ slots: Slot[]; models: Record<string, string>; mockOnly?: boolean }>("/api/models/slots");
    setState("slots", d.slots || []);
    setState("models", reconcile(d.models || {}));
    setState("mockOnly", !!d.mockOnly);
  } catch (e) {
    console.warn("models:", e);
  }
}

/** Monotonic token for memory reads. A response may only land if no newer
 *  fetch started and the active conversation is still the one it was asked
 *  for. Without this, `turn_end`'s fire-and-forget refresh (fired right before
 *  "new chat" is clicked) could resolve *after* the fresh session's fetch and
 *  repaint the new panel with the old conversation's values — where they would
 *  sit until the next turn ended. */
let memoryFetch = 0;

export async function refreshMemory(): Promise<void> {
  const forSession = state.active;
  // No session on screen: the endpoint would answer for whatever the server
  // considers active, which is exactly the old conversation's map. Show none.
  if (!forSession) {
    setState({ memory: {}, memorySession: null });
    return;
  }
  const token = ++memoryFetch;
  try {
    const d = await getJSON<{ apps: Record<string, Record<string, unknown>> }>(
      `/api/tree/memory?session=${encodeURIComponent(forSession)}`,
    );
    if (token !== memoryFetch || state.active !== forSession) return;
    setState("memory", d.apps || {});
    setState("memorySession", forSession);
  } catch {
    if (token !== memoryFetch || state.active !== forSession) return;
    setState("memory", {});
    setState("memorySession", forSession);
  }
}

/** The URL carries the open chat (`?session=<key>`), so a reload — or a
 *  bookmark — resumes it instead of dropping into a fresh one. Kept as a
 *  mirror of `state.active`: every path that changes the visible session goes
 *  through `refreshSession` (drawer pick, new chat, delete, telegram-follow,
 *  SSE "cleared"/"sessions"), so one call site keeps the address bar honest.
 *  `replaceState`, not `pushState`: the screen still follows one session, and
 *  back/forward should not walk a session history. Other query params
 *  (`server`, `remote` on the browser target) are preserved. */
function updateSessionUrl(key: string | null): void {
  try {
    const url = new URL(location.href);
    const current = url.searchParams.get("session");
    if (key) {
      if (current === key) return;
      url.searchParams.set("session", key);
    } else {
      if (current === null) return;
      url.searchParams.delete("session");
    }
    history.replaceState(history.state, "", url);
  } catch {
    /* no history (sandboxed frame) — the chat still works, only the URL lags */
  }
}

export async function refreshSession(
  /** Boot-only hook: reports the two slow phases ("turns" arrived, then
   *  "memory" + models), so the splash's bar advances instead of freezing.
   *  Ordinary session switches pass nothing. */
  onStep?: (step: "turns" | "memory") => void,
): Promise<void> {
  const d = await getJSON<{
    active: string | null;
    label: string;
    follow: boolean;
    models: Record<string, string>;
    awaiting: string | null;
    sessions: SessionInfo[];
    turns: Turn[] | null;
  }>("/api/session");
  const previous = state.active;
  setState({
    active: d.active,
    label: d.label || "",
    follow: !!d.follow,
    awaiting: d.awaiting ?? null,
    sessions: d.sessions || [],
    turns: d.turns || [],
    // History on open = a resumed conversation, not a fresh chat. The memory
    // panel says so, so restored values read as restored.
    sessionResumed: (d.turns?.length ?? 0) > 0,
  });
  // The panel shows the conversation it was fetched for — never a previous
  // one while the new fetch is in flight. Clear it the moment the screen
  // changes; the guarded fetch below fills it, or the empty state stands.
  if (d.active !== previous) {
    setState({ memory: {}, memorySession: null });
    // A lifted tile belongs to the chat that opened it, not to the next one.
    clearFront();
  }
  // The address bar follows the screen (and loses the param when the active
  // session is deleted and nothing is selected).
  updateSessionUrl(d.active);
  setState("models", reconcile(d.models || {}));
  syncLastError(d.turns || []);
  onStep?.("turns");
  await Promise.all([refreshMemory(), refreshModels()]);
  onStep?.("memory");
}

/** Reload just the active session's turns (after a turn ends / on follow). */
export async function refreshTurns(): Promise<void> {
  try {
    const d = await getJSON<{ turns: Turn[]; session: string | null; awaiting: string | null }>("/api/turns");
    if (d.session !== state.active) return;
    const turns = capEvents(d.turns || []);
    setState({ turns, awaiting: d.awaiting ?? null });
    syncLastError(turns);
  } catch (e) {
    console.warn("turns:", e);
  }
}

/** Reflect the latest failure in the banner (so a reload still warns). Covers
 *  a failed turn AND a turn that completed with a swallowed model-call
 *  failure (e.g. the context condenser timing out). */
function syncLastError(turns: Turn[]): void {
  const last = turns[turns.length - 1];
  if (!last) {
    setState("lastError", null);
    return;
  }
  if (last.status === "error") {
    setState("lastError", {
      title: last.fallback?.length ? "MODEL OUT OF CREDIT" : "TURN FAILED",
      text: last.error || "the turn failed",
    });
    return;
  }
  if (last.status === "stopped") {
    setState("lastError", null);
    return;
  }
  const llmErr = last.events.find((e) => e.kind === "llm_error");
  if (llmErr) {
    const text = String((llmErr.content as Record<string, unknown> | null)?.error ?? "a model call failed");
    setState("lastError", { title: "MODEL CALL FAILED", text });
    return;
  }
  setState("lastError", null);
}

// ── actions ─────────────────────────────────────────────────────────────

export async function send(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  try {
    await postJSON("/api/chat", { text: t });
    setState("awaiting", null); // a turn is now running; hide the input
  } catch (e) {
    toast(e instanceof Error ? e.message : "send failed", true);
  }
}

/**
 * Stop the running tree. The server aborts model/tool work and unwinds the
 * engine; the turn ends as "stopped" and the previous checkpoint remains.
 */
export async function stop(): Promise<void> {
  try {
    const d = await postJSON<{ stopped?: boolean }>("/api/chat/stop", {});
    if (!d.stopped) toast("nothing is running");
  } catch (e) {
    toast(e instanceof Error ? e.message : "stop failed", true);
  }
}

/** Resend the last turn's input — the manual escape when a turn failed. */
export async function retryLast(): Promise<void> {
  const last = state.turns[state.turns.length - 1];
  if (!last || !last.input) return;
  await send(last.input);
}

// ── attachments & voice ─────────────────────────────────────────────────

export interface TranscribeHandlers {
  /** The clip's duration in seconds, once known. */
  onInfo?: (duration: number) => void;
  /** A growing transcript; `at` is the position (seconds) it has reached. */
  onPartial?: (text: string, at?: number) => void;
}

/** Upload a non-audio file as an attachment turn (optional caption). */
export async function sendFile(file: File, caption: string): Promise<void> {
  const fd = new FormData();
  fd.append("file", file);
  const cap = caption.trim();
  if (cap) fd.append("caption", cap);
  try {
    await postForm("/api/chat/upload", fd);
    setState("awaiting", null);
    await refreshTurns();
  } catch (e) {
    toast(e instanceof Error ? e.message : "upload failed", true);
    throw e;
  }
}

/** The container extension ffmpeg should expect for an uploaded/recorded clip. */
function audioExt(filename: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename);
  return match ? `.${match[1].toLowerCase()}` : ".webm";
}

interface DesktopTranscriber {
  transcribe(audio: Uint8Array, ext: string): Promise<string>;
}

/** The paired desktop/server connection, when this tab has one. */
function desktopTranscriber(): DesktopTranscriber | null {
  const server = (globalThis as { __bobServer?: unknown }).__bobServer;
  if (!server || typeof server !== "object") return null;
  return typeof (server as { transcribe?: unknown }).transcribe === "function"
    ? (server as DesktopTranscriber)
    : null;
}

function heardText(raw: string | undefined): string {
  const text = raw?.trim();
  if (!text) throw new Error("transcription came back empty");
  return text;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A fetch-level failure on a page that is not running on the bridge machine. */
function atRemotePage(err: unknown): boolean {
  if (!(err instanceof TypeError) || typeof location === "undefined") return false;
  try {
    return !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
  } catch {
    return false;
  }
}

/**
 * Transcribe a clip on whichever side can hear it. A paired desktop is the
 * cross-device path (a phone cannot reach the bridge's loopback `/stt`); on
 * the desktop itself, the direct pass-through is the fallback. The channel
 * never stores the audio: ffmpeg + whisper-server run beside the bridge.
 */
async function transcribeBlob(blob: Blob, filename: string): Promise<string> {
  const ext = audioExt(filename);
  const desktop = desktopTranscriber();
  let desktopError: unknown = null;
  if (desktop) {
    try {
      return heardText(await desktop.transcribe(new Uint8Array(await blob.arrayBuffer()), ext));
    } catch (err) {
      desktopError = err;
    }
  }
  try {
    const url = new URL("/stt", bridgeUrl());
    url.searchParams.set("ext", ext);
    const res = await fetch(url, { method: "POST", body: blob });
    const d = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) throw new Error(d.error || `transcription failed: HTTP ${res.status}`);
    return heardText(d.text);
  } catch (err) {
    if (desktopError) {
      throw new Error(`desktop: ${errorText(desktopError)}; bridge: ${errorText(err)}`);
    }
    if (atRemotePage(err)) {
      throw new Error(
        "this device cannot reach a transcription bridge — pair a desktop in Sync… → Pair… " +
          "(start it with BOB_STT=1)",
      );
    }
    throw err;
  }
}

/**
 * Transcribe an audio file through the bridge. The old streaming partials
 * are gone with the admin; `onPartial` simply never fires.
 */
export async function transcribeFileStream(
  file: File,
  handlers: TranscribeHandlers = {},
): Promise<string> {
  handlers.onInfo?.(0);
  return transcribeBlob(file, file.name || "audio.webm");
}

/** Transcribe a recorded voice clip through the bridge's STT pass-through. */
export async function transcribeAudio(blob: Blob, filename: string): Promise<string> {
  return transcribeBlob(blob, filename);
}

export async function selectSession(key: string): Promise<void> {
  try {
    await postJSON("/api/session", { key });
    await refreshSession();
  } catch (e) {
    toast(e instanceof Error ? e.message : "could not open session", true);
  }
}

export async function newSession(): Promise<void> {
  try {
    await postJSON("/api/session", { new: true });
    // A fresh chat opens on the profile's board: an explicit "hidden… except:"
    // list decides which tiles stay; without one, trunk alone is on the board.
    resetBoardForNewSession();
    await refreshSession();
  } catch (e) {
    toast(e instanceof Error ? e.message : "could not start a session", true);
  }
}

export async function deleteSession(key: string): Promise<void> {
  try {
    await postJSON("/api/session", { delete: key });
    // Deleting the bridged chat ends the bridge (the phone has nowhere to go).
    try {
      if (state.bridgeOn && localStorage.getItem(`${BRIDGE_KEY}-session`) === key) {
        setBridge(false);
      }
    } catch {
      /* private mode */
    }
    await refreshSession();
  } catch (e) {
    toast(e instanceof Error ? e.message : "could not delete session", true);
  }
}

/** Rename a session (defaults to the active one). */
export async function renameSession(label: string, key?: string): Promise<void> {
  try {
    await postJSON("/api/session", key ? { key, label } : { label });
    await refreshSession();
    toast(label.trim() ? `renamed: ${label.trim()}` : "session name cleared");
  } catch (e) {
    toast(e instanceof Error ? e.message : "rename failed", true);
  }
}

export async function setFollow(on: boolean): Promise<void> {
  try {
    await postJSON("/api/session", { follow: on });
    await refreshSession();
  } catch (e) {
    toast(e instanceof Error ? e.message : "could not change follow", true);
  }
}

export async function setPattern(name: string): Promise<void> {
  if (!name || name === state.pattern) return;
  try {
    await postJSON("/api/pattern", { name });
    setState("pattern", name);
    await refreshSession();
    toast(`pattern: ${name} — conversation cleared`);
  } catch (e) {
    toast(e instanceof Error ? e.message : "pattern switch failed", true);
  }
}

/** Confirm a quota fallback: retarget the failed model role and re-run the
 *  turn the 402 killed. The server holds the pending turn, so this only names
 *  the slot. */
export async function chooseFallback(slot: string): Promise<void> {
  if (!slot) return;
  try {
    await postJSON("/api/fallback", { slot });
    setState("awaiting", null); // a turn is now running
    toast(`falling back to ${slot}`);
    await refreshModels();
  } catch (e) {
    toast(e instanceof Error ? e.message : "fallback failed", true);
    await refreshTurns();
  }
}

export async function setModel(role: string, slot: string): Promise<void> {
  try {
    const d = await postJSON<{ models: Record<string, string> }>("/api/chat/model", { role, slot: slot || null });
    setState("models", reconcile(d.models || {}));
    toast(slot ? `${role}: ${slot}` : `${role}: default`);
  } catch (e) {
    toast(e instanceof Error ? e.message : "model switch failed", true);
    await refreshModels();
  }
}

export async function clearConversation(): Promise<void> {
  try {
    await postJSON("/api/clear", {});
    await Promise.all([refreshTurns(), refreshMemory()]);
    toast("conversation cleared");
  } catch (e) {
    toast(e instanceof Error ? e.message : "clear failed", true);
  }
}

interface TelegramTarget {
  conv: string;
  /** Live binding epoch; null when only the remembered chat is known. */
  epoch: number | null;
}

/** Live bindings for this profile, or null when the channel is unreachable. */
async function telegramBindings(
  channel: string,
  profile: string,
): Promise<Array<{ conv: string; epoch: number }> | null> {
  try {
    const res = await fetch(`${channel}/api/bindings?profile=${encodeURIComponent(profile)}`);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as {
      bindings?: Array<{ conv?: unknown; epoch?: unknown }>;
    };
    return (data.bindings ?? []).filter(
      (b): b is { conv: string; epoch: number } =>
        typeof b?.conv === "string" && typeof b?.epoch === "number",
    );
  } catch {
    return null;
  }
}

/** The chat this profile last used, kept after the live binding expires. */
function savedTelegramChat(profile: string): { conv: string; epoch: number } | null {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`${BRIDGE_CONV_KEY}:${profile}`) || "null",
    ) as unknown;
    if (!saved || typeof saved !== "object") return null;
    const conv = (saved as { conv?: unknown }).conv;
    const epoch = (saved as { epoch?: unknown }).epoch;
    if (typeof conv === "string" && /^-?\d+(?::\d+)?$/.test(conv)) {
      return { conv, epoch: typeof epoch === "number" ? epoch : 0 };
    }
  } catch {
    /* private mode / corrupt */
  }
  return null;
}

/**
 * Resolve the chat a one-shot send should target. Bindings form when a tab
 * claims parked messages, so a chat the user already messaged but never
 * bridged is claimed here first. The remembered chat is the fallback after
 * the 15 s binding expiry.
 */
async function telegramTarget(channel: string, profile: string): Promise<TelegramTarget | null> {
  let bindings = await telegramBindings(channel, profile);
  if (bindings && !bindings.length) {
    try {
      await fetch(`${channel}/api/inbox?profile=${encodeURIComponent(profile)}`);
    } catch {
      /* channel down: fall through to the saved chat */
    }
    bindings = await telegramBindings(channel, profile);
  }
  const live = bindings?.[0];
  if (live) return { conv: live.conv, epoch: live.epoch };
  const saved = savedTelegramChat(profile);
  if (saved) return { conv: saved.conv, epoch: null };
  if (bindings === null) throw new Error(`telegram channel unreachable at ${channel}`);
  return null;
}

/** Pin the bridge to this session once the transcript reached the phone. */
function linkTelegramChat(target: TelegramTarget, session: string, profile: string): void {
  try {
    localStorage.setItem(BRIDGE_KEY, "1");
    localStorage.setItem(`${BRIDGE_KEY}-session`, session);
    localStorage.setItem(
      `${BRIDGE_CONV_KEY}:${profile}`,
      JSON.stringify({ conv: target.conv, epoch: target.epoch ?? 0 }),
    );
  } catch {
    /* private mode */
  }
  setState("bridgeOn", true);
}

/** Push the active session's transcript to Telegram and link the two. */
export async function sendToTelegram(): Promise<void> {
  const session = state.active;
  if (!session) {
    toast("no active chat to send", true);
    return;
  }
  try {
    // The linked chat is the freshest chat bound to this profile on the
    // telegram channel (bindings form when a tab claims parked messages).
    const channel = telegramChannelUrl();
    const profile = profileId();
    const target = await telegramTarget(channel, profile);
    if (!target) {
      toast("no telegram chat linked yet — message the bot on Telegram first", true);
      return;
    }
    const tRes = await fetch("/api/turns", { headers: { accept: "application/json" } });
    const tData = (await tRes.json().catch(() => ({}))) as {
      turns?: Array<{ input?: string; status?: string; error?: string; output?: string }>;
      session?: string;
    };
    const turns = tData.turns ?? [];
    if (!turns.length) {
      // Nothing to post, but the click still links the two conversations:
      // the next web turn mirrors to the phone and phone messages run here.
      linkTelegramChat(target, session, profile);
      toast("linked to telegram — this session has no turns to send yet");
      return;
    }
    // Plain-text transcript: one block per turn, errors kept as ⚠️ lines.
    const sessionName = tData.session ?? "session";
    const lines: string[] = [
      `📋 transcript · ${sessionName} (${turns.length} turn${turns.length === 1 ? "" : "s"})`,
    ];
    for (const t of turns) {
      lines.push("", "—— you ——", t.input || "(empty)");
      lines.push("—— bob ——", t.status === "error" ? `⚠️ ${t.error ?? "error"}` : t.output || "(no reply)");
    }
    const body: Record<string, unknown> = {
      key: target.conv,
      text: lines.join("\n"),
      profile,
    };
    // A saved (expired) binding has no epoch to send; the channel accepts an
    // epoch-less relay and drops it only when another profile owns the chat.
    if (target.epoch !== null) body.epoch = target.epoch;
    const rRes = await fetch(`${channel}/api/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!rRes.ok) throw new Error(`relay failed: HTTP ${rRes.status}`);
    const rData = (await rRes.json().catch(() => ({}))) as {
      dropped?: unknown;
      skipped?: unknown;
    };
    if (typeof rData.dropped === "string") throw new Error(`relay dropped: ${rData.dropped}`);
    if (typeof rData.skipped === "string") throw new Error(`relay skipped: ${rData.skipped}`);
    // The phone now follows this session: pin the bridge to it so later web
    // turns mirror there and incoming phone messages run in this chat.
    linkTelegramChat(target, session, profile);
    toast("sent to telegram — this chat is now linked to that conversation");
  } catch (e) {
    toast(e instanceof Error ? e.message : "send to telegram failed", true);
  }
}

/**
 * Enable/disable the two-way bridge from this tab. The in-browser backend
 * polls localStorage: while on it heartbeats and relays; turning it off makes
 * the next tick tell the admin, so the bot resumes its own session at once
 * instead of waiting for the heartbeat to expire.
 */
export function setBridge(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(BRIDGE_KEY, "1");
      if (state.active) localStorage.setItem(`${BRIDGE_KEY}-session`, state.active);
    } else {
      localStorage.removeItem(BRIDGE_KEY);
      localStorage.removeItem(`${BRIDGE_KEY}-session`);
    }
  } catch {
    /* private mode */
  }
  setState("bridgeOn", on);
  toast(
    on
      ? "bridge on — this chat is shared with your phone while the tab is open"
      : "bridge off",
  );
}

// ── message provenance ──────────────────────────────────────────────────

/**
 * Fetch "what was this message written from" for one bubble: the prompt that
 * produced it, the memory slots and other pieces it read (their writers), and
 * ref:// handles. `bubble` is the turn-level emit index (-1 = last emit);
 * `depth` grows the walk when the user asks to trace deeper. The endpoint's
 * friendly error text (a turn with no run, no emits) is surfaced as-is.
 */
export async function fetchProvenance(p: {
  turnId: string;
  bubble: number;
  text?: string;
  depth?: number;
}): Promise<Provenance> {
  const q = new URLSearchParams({ turnId: p.turnId, bubble: String(p.bubble) });
  if (p.text) q.set("text", p.text);
  if (p.depth && p.depth > 1) q.set("depth", String(p.depth));
  const r = await fetch(`/api/provenance?${q.toString()}`, { cache: "no-store" });
  const d = (await r.json().catch(() => ({}))) as Partial<Provenance> & { error?: string };
  if (!r.ok) throw new Error(d.error || `/api/provenance: ${r.status}`);
  return d as Provenance;
}

/**
 * Resolve one `ref://<seq>[/path]` handle to the run-log row it points at.
 * `path` (the `/list` in `ref://123/list`) drills into the row's value.
 */
export async function fetchRef(seq: number, path?: string | null): Promise<RefTarget> {
  const q = new URLSearchParams({ seq: String(seq) });
  if (path) q.set("path", path);
  const r = await fetch(`/api/ref?${q.toString()}`, { cache: "no-store" });
  const d = (await r.json().catch(() => ({}))) as Partial<RefTarget> & { error?: string };
  if (!r.ok) throw new Error(d.error || `/api/ref: ${r.status}`);
  return d as RefTarget;
}

// ── display settings ────────────────────────────────────────────────────

/** Show/hide machine-tagged emits across every app chat, and persist it. */
export function toggleMachine(): void {
  const next = !state.showMachine;
  setState("showMachine", next);
  try {
    localStorage.setItem(MACHINE_KEY, next ? "1" : "0");
  } catch {
    /* private mode */
  }
}

/** Expand/collapse the event stream. On a small screen "collapsed" means
 *  hidden entirely and "open" means the bottom sheet. `persist: false` is the
 *  auto-hide: the breakpoint fold must not overwrite the user's desktop pref. */
export function setStreamOpen(open: boolean, persist = true): void {
  setState("streamOpen", open);
  if (!persist) return;
  try {
    localStorage.setItem(STREAM_KEY, open ? "1" : "0");
  } catch {
    /* private mode */
  }
}

export function toggleStream(): void {
  setStreamOpen(!state.streamOpen);
}

/** Record that an app did something, for the most-recent-first tile order.
 *  `app` is the attributed tree name; trunk is the default attribution. */
function touchActivity(app: string | null | undefined, at?: number): void {
  const name = app || "trunk";
  const when = at && Number.isFinite(at) && at > 0 ? at : Date.now();
  setState("activity", name, Math.max(state.activity[name] ?? 0, when));
}

/** The board tile that carries `app`: a parented app surfaces through its
 *  top-level ancestor (sub-apps never board). Null for trunk / unknown apps. */
function boardTileOf(app: string | null | undefined): string | null {
  if (!app || app === "trunk") return null;
  let cur = state.apps.find((a) => a.name === app);
  const seen = new Set<string>();
  while (cur?.parent) {
    if (seen.has(cur.name)) return null;
    seen.add(cur.name);
    const parentName: string = cur.parent;
    cur = state.apps.find((a) => a.name === parentName);
  }
  return cur ? cur.name : null;
}

/** Board seats in use: every visible tile except trunk. */
function appSeatsUsed(): number {
  return orderedApps().reduce((n, a) => n + (a.name === "trunk" ? 0 : 1), 0);
}

let raiseDeniedTimer: ReturnType<typeof setTimeout> | undefined;

function setRaiseDenied(name: string): void {
  setState("raiseDenied", name);
  clearTimeout(raiseDeniedTimer);
  raiseDeniedTimer = setTimeout(() => {
    if (state.raiseDenied === name) setState("raiseDenied", null);
  }, RAISE_DENIED_MS);
}

function clearRaiseDenied(name?: string): void {
  if (name && state.raiseDenied !== name) return;
  clearTimeout(raiseDeniedTimer);
  if (state.raiseDenied !== null) setState("raiseDenied", null);
}

/** Live activity for `app`: raise its parked tile while a seat is free,
 *  otherwise leave it in the rail with a pulsing square. Only live SSE frames
 *  call this (never history seeding), so switching sessions does not
 *  rearrange the board. */
function maybeRaiseTile(app: string | null | undefined): void {
  const tile = boardTileOf(app);
  if (!tile) return;
  if (!state.layout.hidden.includes(tile)) {
    clearRaiseDenied(tile);
    return;
  }
  if (appSeatsUsed() >= AUTO_RAISE_SEATS) {
    setRaiseDenied(tile);
    return;
  }
  setState("layout", "hidden", (h) => h.filter((x) => x !== tile));
  if (!(state.layout.autoRaised ?? []).includes(tile)) {
    setState("layout", "autoRaised", (list) => [...(list ?? []), tile]);
  }
  saveLayout();
  clearRaiseDenied(tile);
}

/** The board tiles a turn used: its input app, every event's attributed app
 *  (including nested sub-apps, mapped to the top-level tile) and every app that
 *  emitted a bubble. Trunk and unknown apps never name a board seat. */
function turnTileApps(turn: Turn): string[] {
  const tiles = new Set<string>();
  const add = (app: string | null | undefined): void => {
    const tile = boardTileOf(app);
    if (tile) tiles.add(tile);
  };
  add(turn.inputApp);
  add(turn.awaiting);
  for (const ev of turn.events ?? []) add(ev.app);
  for (const app of turn.emitApps ?? []) add(app);
  return [...tiles];
}

/**
 * Park auto-raised tiles that no turn has used for `AUTO_CLOSE_TURNS` turns.
 * The just-finished turn is part of that window, so an auto-raised tile closes
 * at the end of the second turn that ignored it. Manual opens, pinned tiles,
 * profile exceptions and the app currently waiting for the human are kept —
 * the rail square stays one click away (and a used app raises again).
 *
 * Returns true when at least one tile parked, so the caller can give a seat to
 * the app the finished turn was actually using.
 */
function pruneStaleTiles(): boolean {
  if (state.turns.length < AUTO_CLOSE_TURNS) return false;
  const recent = new Set<string>();
  for (const turn of state.turns.slice(-AUTO_CLOSE_TURNS)) {
    for (const tile of turnTileApps(turn)) recent.add(tile);
  }
  const keep = new Set<string>(["trunk", ...(profileVisibleApps() ?? [])]);
  for (const turn of state.turns) {
    if (turn.status !== "running") continue;
    for (const tile of turnTileApps(turn)) keep.add(tile);
  }
  if (state.awaiting) {
    const waiting = boardTileOf(state.awaiting);
    if (waiting) keep.add(waiting);
  }
  // A lifted tile is being read right now; do not park it out from under the
  // person at the end of a turn that happened not to use it.
  if (state.front) keep.add(state.front);
  const auto = new Set(state.layout.autoRaised ?? []);
  const stale = state.apps
    .filter(
      (app) =>
        !app.parent &&
        auto.has(app.name) &&
        !state.layout.hidden.includes(app.name) &&
        !state.layout.pinned.includes(app.name) &&
        !keep.has(app.name) &&
        !recent.has(app.name),
    )
    .map((app) => app.name);
  if (!stale.length) return false;
  const parked = new Set(stale);
  setState("layout", "hidden", (hidden) => [...hidden, ...stale.filter((name) => !hidden.includes(name))]);
  setState("layout", "autoRaised", (list) => (list ?? []).filter((name) => !parked.has(name)));
  for (const name of stale) clearFront(name);
  clearRaiseDenied();
  saveLayout();
  return true;
}

/** The most recent app a live event was attributed to. Turns fire an event per
 *  step; bumping the owning tile on every one of them would reshuffle the grid
 *  several times a second, so activity only moves when the run changes app. */
let lastTouchedApp: string | null = null;

/** Seed recency from turn history (a reload, a session switch, a refresh) so
 *  the order survives without persisting timestamps. Replayed events all carry
 *  the read time as their `ts` (sanitize.ts mints it), so the clock here is the
 *  turn's real `startedAt` plus the event's position as a fraction of a
 *  millisecond: order inside a turn is preserved and nothing crosses into the
 *  next turn. Only the tail matters — older activity cannot outrank recent work. */
const ACTIVITY_TURNS = 20;

function seedActivityFromTurns(turns: Turn[]): void {
  const latest: Record<string, number> = {};
  const bump = (app: string | null | undefined, at: number | null | undefined): void => {
    const name = app || "trunk";
    if (!at || !Number.isFinite(at) || at <= 0) return;
    if (at > (latest[name] ?? 0)) latest[name] = at;
  };
  for (const t of turns.slice(-ACTIVITY_TURNS)) {
    bump(t.inputApp, t.startedAt);
    t.events.forEach((ev, i) => {
      if (ev.app) bump(ev.app, t.startedAt + (i + 1) / 1000);
    });
  }
  // Merge instead of replacing: a live-touched app outranks anything history
  // reports (history timestamps are never newer than "just now").
  setState(
    produce((s) => {
      for (const [name, at] of Object.entries(latest)) {
        if (at > (s.activity[name] ?? 0)) s.activity[name] = at;
      }
    }),
  );
}

// ── layout tweaks ───────────────────────────────────────────────────────

/** Dismiss the global turn-failure banner. */
export function dismissError(): void {
  setState("lastError", null);
}

export function toggleHidden(name: string): void {
  const wasHidden = state.layout.hidden.includes(name);
  setState("layout", "hidden", (h) => (h.includes(name) ? h.filter((x) => x !== name) : [...h, name]));
  // A manual open (or park) takes the tile out of the bot's auto-close list:
  // the user has now expressed an intent about this seat.
  setState("layout", "autoRaised", (list) => (list ?? []).filter((x) => x !== name));
  saveLayout();
  // A manual open answers the app's pulse; parking a tile leaves the others be.
  if (wasHidden) clearRaiseDenied(name);
  // A parked tile cannot stay lifted over a board it no longer belongs to.
  else clearFront(name);
}

/** Park every board tile except trunk and `keep`, restoring any of those that
 *  were parked before. Starting a session uses this so a fresh chat opens on
 *  trunk alone; the rail still lists everything else. Parented apps are left
 *  alone — their seat is the parent's rail, never the board's. */
export function parkAllExcept(keep: readonly string[] = NEW_SESSION_KEEP): void {
  const shown = new Set(["trunk", ...keep]);
  setState(
    "layout",
    "hidden",
    state.apps.filter((a) => !a.parent && !shown.has(a.name)).map((a) => a.name),
  );
  // Nothing on the board was raised by this tab any more: a fresh board starts
  // with no auto-close bookkeeping.
  setState("layout", "autoRaised", []);
  clearRaiseDenied();
  clearFront();
  saveLayout();
}

/**
 * The active profile's "hidden… except:" list, published by the browser host
 * before the app mounts. `null` means the profile has no explicit list, so the
 * trunk-only board stays the new-chat default.
 */
function profileVisibleApps(): string[] | null {
  if (typeof window === "undefined") return null;
  const raw = (window as unknown as { __bobProfileVisibleApps?: unknown }).__bobProfileVisibleApps;
  if (!Array.isArray(raw)) return null;
  return raw.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

/** Hide every top-level tile the profile did not list as a board exception.
 *  On boot this reasserts the profile default over the saved layout; apps are
 *  still reachable from the rail, and live runs can raise up to two seats. */
export function applyProfileVisibleExceptions(): void {
  const exceptions = profileVisibleApps();
  if (exceptions === null) return;
  const visible = new Set(exceptions);
  setState(
    "layout",
    "hidden",
    state.apps
      .filter((app) => !app.parent && app.name !== "trunk" && !visible.has(app.name))
      .map((app) => app.name),
  );
  setState("layout", "autoRaised", []);
  clearRaiseDenied();
  clearFront();
  saveLayout();
}

/** Reset the board for a new chat: an explicit profile exception list decides
 *  which tiles stay visible; without one, trunk alone stays and active apps
 *  raise themselves. */
export function resetBoardForNewSession(): void {
  const exceptions = profileVisibleApps();
  if (exceptions === null) {
    parkAllExcept();
    return;
  }
  const visible = new Set(exceptions);
  setState(
    "layout",
    "hidden",
    state.apps
      .filter((app) => !app.parent && app.name !== "trunk" && !visible.has(app.name))
      .map((app) => app.name),
  );
  setState("layout", "autoRaised", []);
  clearRaiseDenied();
  clearFront();
  saveLayout();
}

export function toggleExpanded(name: string): void {
  setState("layout", "expanded", (h) => (h.includes(name) ? h.filter((x) => x !== name) : [...h, name]));
  saveLayout();
}
export function toggleWide(name: string): void {
  setState("layout", "wide", (h) => (h.includes(name) ? h.filter((x) => x !== name) : [...h, name]));
  saveLayout();
}

/** Lift one tile into the phone's front layer, or put it back when it is
 *  already there. Only one tile can be in front: tapping another header hands
 *  the overlay to that tile. The desktop board has no overlay; the gesture is a
 *  phone affordance, so a wider viewport ignores it. */
export function toggleFront(name: string): void {
  if (!smallScreen()) return;
  setState("front", (cur) => (cur === name ? null : name));
}

/** Lower the front tile — all of them, or only `name` when given. */
export function clearFront(name?: string): void {
  if (state.front == null) return;
  if (name != null && state.front !== name) return;
  setState("front", null);
}

/** Whether a tile's memory panel is open: an explicit choice wins, then the
 *  layout default — a wide tile or a phone keeps memory collapsed; a normal
 *  desktop tile opens it. */
export function memoryOpen(name: string): boolean {
  if (state.layout.memOpen.includes(name)) return true;
  if (state.layout.memClosed.includes(name)) return false;
  if (state.layout.wide.includes(name)) return false;
  return !smallScreen();
}

/** Collapse or open a tile's memory panel (persisted, like the rest of the
 *  layout — tiles remount on every session switch). */
export function toggleMem(name: string): void {
  if (memoryOpen(name)) {
    setState("layout", "memClosed", (list) => (list.includes(name) ? list : [...list, name]));
    setState("layout", "memOpen", (list) => list.filter((x) => x !== name));
  } else {
    setState("layout", "memClosed", (list) => list.filter((x) => x !== name));
    setState("layout", "memOpen", (list) => (list.includes(name) ? list : [...list, name]));
  }
  saveLayout();
}

/** Pin a tile: it keeps its place (and becomes manually draggable) while the
 *  unpinned tiles follow recent activity. Trunk starts pinned. */
export function togglePinned(name: string): void {
  setState("layout", "pinned", (p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  // A pinned tile needs an anchor in the manual order. On a board that has never
  // been reordered that list is empty, and base order would then put the new pin
  // above the other pins (order entries come before unknown names) — so anchor
  // every pinned tile first, then append the new one at the end of the block.
  setState("layout", "order", (order) => {
    const next = [...order];
    for (const n of state.layout.pinned) if (!next.includes(n)) next.push(n);
    return next;
  });
  saveLayout();
}

export function moveTile(from: string, to: string): void {
  if (from === to) return;
  // Only pinned tiles have a manual order: an unpinned tile follows activity, so
  // a drop involving one would be undone by the next event. Pin it first.
  if (!state.layout.pinned.includes(from) || !state.layout.pinned.includes(to)) return;
  setState("layout", "order", (order) => {
    const names = order.length ? [...order] : [];
    for (const n of [from, to]) if (!names.includes(n)) names.push(n);
    const fi = names.indexOf(from);
    const ti = names.indexOf(to);
    if (fi < 0 || ti < 0) return order;
    names.splice(fi, 1);
    names.splice(ti, 0, from);
    return names;
  });
  saveLayout();
}

/** Saved order first, then any app the order has never seen (server order). */
function baseOrderApps(): AppInfo[] {
  const byName = new Map(state.apps.map((a) => [a.name, a]));
  const seen = new Set<string>();
  const out: AppInfo[] = [];
  for (const n of state.layout.order) {
    const a = byName.get(n);
    if (a && !seen.has(n)) {
      out.push(a);
      seen.add(n);
    }
  }
  for (const a of state.apps) if (!seen.has(a.name)) out.push(a);
  return out;
}

/** Every app in board order: the pinned block first (manual order), then the
 *  unpinned apps by most recent activity. Ties — and apps that have never run —
 *  keep the base order, so nothing moves until something happens. */
function boardOrder(): AppInfo[] {
  const base = baseOrderApps();
  const pinned = new Set(state.layout.pinned);
  const rank = new Map(base.map((a, i) => [a.name, i]));
  const head = base.filter((a) => pinned.has(a.name));
  const tail = base
    .filter((a) => !pinned.has(a.name))
    .sort((a, b) => {
      const delta = (state.activity[b.name] ?? 0) - (state.activity[a.name] ?? 0);
      return delta !== 0 ? delta : (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0);
    });
  return [...head, ...tail];
}

/** The visible board: board order minus hidden tiles. Sub-apps never board —
 *  they park inside their parent's tile rail (`subApps`/`toggleSub`). */
export function orderedApps(): AppInfo[] {
  return boardOrder().filter((a) => !state.layout.hidden.includes(a.name) && !a.parent);
}

/** The hidden tiles, in board order — the rail shows them where they would land
 *  if restored. Parented apps are excluded: their seat is the parent's rail. */
export function hiddenApps(): AppInfo[] {
  return boardOrder().filter((a) => state.layout.hidden.includes(a.name) && !a.parent);
}

/** Every sub-app parked under one parent, in board order — the parent tile's
 *  rail lists them this way (squares stay listed whether open or parked). */
export function subApps(parent: string): AppInfo[] {
  return boardOrder().filter((a) => a.parent === parent);
}

/** The sub-apps of one parent that are currently opened beside its chat, in
 *  the order they were opened (layout.subsOpen order, filtered to live ones). */
export function openSubApps(parent: string): AppInfo[] {
  const kids = new Map(subApps(parent).map((a) => [a.name, a]));
  return state.layout.subsOpen
    .map((n) => kids.get(n))
    .filter((a): a is AppInfo => !!a);
}

/** Open a parked sub-app beside its parent's chat, or park it back into the
 *  parent's rail. The open order is the render order, so docking a chat keeps
 *  its spot while the others shuffle around it. */
export function toggleSub(name: string): void {
  const parking = state.layout.subsOpen.includes(name);
  setState("layout", "subsOpen", (list) =>
    list.includes(name) ? list.filter((x) => x !== name) : [...list, name],
  );
  saveLayout();
  // A parked sub-app cannot stay lifted over the board.
  if (parking) clearFront(name);
}

/** Bring an app's real tile into view: unhide its top-level ancestor, open the
 *  parented chain in each parent's rail, then scroll the tile into view. The
 *  inline app cards use this as their "open" action. The opened app is brought
 *  *over* the chat it was called from: a sub-app takes over its parent's frame
 *  (the same layer `⤢` gives it), and a top-level app on a phone is lifted into
 *  the front layer above the board and trunk dock. */
export function showApp(name: string): void {
  const app = state.apps.find((a) => a.name === name);
  if (!app) return;
  // Walk to the top-level ancestor, remembering the parented chain root-first.
  const chain: string[] = [];
  let cur: AppInfo | undefined = app;
  const seen = new Set<string>();
  while (cur?.parent && !seen.has(cur.name)) {
    seen.add(cur.name);
    chain.push(cur.name);
    const parent: string = cur.parent;
    cur = state.apps.find((a) => a.name === parent);
  }
  if (!cur) return;
  // Opening a real tile is a request to see it, not whichever tile is currently
  // lifted over the board. Keep an ancestor that is already in front — the
  // destination lives inside it — and lower anything else that would cover it.
  const root = cur.name;
  if (state.front && state.front !== root && !chain.includes(state.front)) clearFront();
  if (state.layout.hidden.includes(root)) toggleHidden(root);
  for (const n of chain.reverse()) {
    if (!state.layout.subsOpen.includes(n)) toggleSub(n);
  }
  if (app.parent) {
    // Over the caller, not beside it: the sub-app claims the parent's frame
    // until its `⤡` gives the frame back. This is the layer the tile's own
    // expand control uses, so the parent chat is beneath it rather than making
    // the new tile share the frame.
    if (!state.layout.expanded.includes(name)) toggleExpanded(name);
  } else if (smallScreen() && state.front !== name) {
    // A top-level app is the board's own layer: on a phone lift it over the
    // grid and the trunk dock, the same seat a header tap gives it.
    toggleFront(name);
  }
  // The tile may have just been mounted; one frame later its seat exists.
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-tile]")).find(
      (node) => node.getAttribute("data-tile") === name,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });
}

// ── live stream (SSE) ───────────────────────────────────────────────────

/**
 * The one live subscription. Re-mounting the app (the browser target swaps
 * chat for settings in place) must not stack subscriptions: every subscriber
 * calls handleSSE, so a leak would append each engine event to the same turn
 * twice. Close before re-opening, and close on unmount (mountApp's dispose).
 */
let stream: EventSource | null = null;
/** The breakpoint listener is page-lifetime, not mount-lifetime (see init). */
let watchingSmallScreen = false;

export function openLiveStream(): void {
  stream?.close();
  stream = openEventStream(handleSSE, (connected) => setState("connected", connected));
}

export function closeLiveStream(): void {
  stream?.close();
  stream = null;
  setState("connected", false);
}

/** Exported for tests: the live stream routes every frame here. */
export function handleSSE(msg: any): void {
  switch (msg?.type) {
    case "turn_start": {
      if (msg.session !== state.active) return;
      if (state.turns.some((t) => t.turnId === msg.turnId)) return;
      // The app the human just spoke to is the most recently active one.
      touchActivity(msg.inputApp, msg.ts);
      maybeRaiseTile(msg.inputApp);
      setState(
        produce((s) => {
          s.turns.push({
            turnId: msg.turnId,
            input: msg.input ?? "",
            inputApp: msg.inputApp ?? "trunk",
            startedAt: msg.ts ?? Date.now(),
            endedAt: null,
            status: "running",
            error: null,
            output: null,
            emits: [],
            levels: [],
            emitApps: [],
            components: [],
            events: [],
          });
          s.awaiting = null;
        }),
      );
      break;
    }
    case "event": {
      const ev = msg.event;
      // Recency ordering: only bump when the run moves to a different app, so a
      // chatty turn does not reshuffle the grid on every step.
      if (ev?.app && ev.app !== lastTouchedApp) {
        lastTouchedApp = ev.app;
        touchActivity(ev.app, typeof ev.ts === "number" ? ev.ts : undefined);
      }
      // Raises are checked on every event (not just app changes), so a seat
      // freed by a manual park can be taken by the app that is still running.
      maybeRaiseTile(ev?.app);
      setState(
        produce((s) => {
          const t = s.turns.find((x) => x.turnId === msg.turnId);
          if (!t) return;
          // The engine run behind the turn — the provenance panel's anchor.
          if (msg.runId && !t.runId) t.runId = msg.runId;
          t.events.push(ev);
          if (t.events.length > MAX_TURN_EVENTS) t.events.splice(0, t.events.length - MAX_TURN_EVENTS);
        }),
      );
      // A swallowed model-call failure (the context condenser, a fold, …) has
      // no turn error of its own — surface it the moment it happens.
      if (ev?.kind === "llm_error") {
        const text = String(ev.content?.error ?? "a model call failed");
        setState("lastError", { title: "MODEL CALL FAILED", text });
        toast(`model call failed: ${text}`, true);
      }
      break;
    }
    case "emit": {
      // An emitted message is activity for the app that wrote it (the event
      // handler already moved the tile when the run entered that app; this
      // keeps the timestamp honest for app-level emits).
      if (msg.app && msg.app !== lastTouchedApp) {
        lastTouchedApp = msg.app;
        touchActivity(msg.app);
      }
      maybeRaiseTile(msg.app);
      setState(
        produce((s) => {
          const t = s.turns.find((x) => x.turnId === msg.turnId);
          if (!t) return;
          // A component-only bubble is still a bubble, so a component keeps
          // the emit arrays aligned even without fallback text.
          if (msg.text || msg.component) {
            (t.emits ??= []).push(msg.text ?? "");
            (t.levels ??= []).push(msg.level ?? null);
            (t.emitApps ??= []).push(msg.app ?? "trunk");
            (t.components ??= []).push(msg.component ?? null);
            if (msg.text) t.output = t.output ? t.output + "\n\n" + msg.text : msg.text;
          }
          if (msg.buttons?.length) t.buttons = msg.buttons;
        }),
      );
      break;
    }
    case "turn_end": {
      setState(
        produce((s) => {
          const t = s.turns.find((x) => x.turnId === msg.turnId);
          if (t) {
            t.status = msg.status ?? "done";
            t.error = msg.error ?? null;
            t.output = msg.output ?? t.output;
            t.endedAt = msg.ts ?? Date.now();
            t.awaiting = msg.awaiting ?? null;
            if (msg.runId) t.runId = msg.runId;
            if (msg.emits) t.emits = msg.emits;
            if (msg.levels) t.levels = msg.levels;
            if (msg.emitApps) t.emitApps = msg.emitApps;
            if (msg.components) t.components = msg.components;
            if (msg.buttons) t.buttons = msg.buttons;
            if (msg.tokens) t.tokens = msg.tokens;
            t.fallback = msg.fallback ?? null;
            if (msg.runMode) t.runMode = msg.runMode;
            if (msg.contextLost != null) t.contextLost = Boolean(msg.contextLost);
          }
          s.awaiting = msg.awaiting ?? null;
        }),
      );
      // The turn that just ended completes the two-turn window: park the
      // auto-raised tiles it and the previous turn ignored, then let the app
      // this turn actually used take any seat that just opened up.
      const ended = state.turns.find((t) => t.turnId === msg.turnId);
      if (ended && pruneStaleTiles()) {
        for (const app of turnTileApps(ended)) maybeRaiseTile(app);
      }
      if (msg.status === "error") {
        toast(`turn failed: ${msg.error || "the turn failed"}`, true);
      } else if (msg.status === "stopped") {
        toast("turn stopped");
      }
      // Re-derive from the turn: a completed turn with a swallowed model
      // failure still warns; a clean turn clears the banner.
      syncLastError(state.turns);
      void refreshMemory();
      break;
    }
    case "memory": {
      // Live memory push: the server sends the node paths a write landed on,
      // so the panel updates as the turn runs rather than only at turn end.
      // Memory is scoped per conversation: a push may merge only when it names
      // the session on screen AND the panel already reflects that same
      // session. A push for another session (or one arriving mid-switch while
      // `active` is still null) would plant foreign values that outlive the
      // switch — so it is dropped, and a mismatched panel is simply refetched.
      if (!msg.app || !msg.values) break;
      if (!msg.session || msg.session !== state.active) break;
      if (state.memorySession !== msg.session) {
        void refreshMemory();
        break;
      }
      setState(
        produce((s) => {
          s.memory[msg.app] = { ...(s.memory[msg.app] || {}), ...msg.values };
        }),
      );
      break;
    }
    case "cleared":
      void refreshTurns();
      void refreshMemory();
      void refreshSession();
      break;
    case "follow":
      void refreshSession();
      break;
    case "sessions":
      void refreshSession();
      break;
    case "trees":
      void refreshPatterns();
      break;
  }
}

/** Boot the UI: load catalogs, resume the chat named in the URL (else open a
 *  fresh one), then follow the live stream. */
export async function init(): Promise<void> {
  // The splash follows these two signals. Progress is deliberately
  // step-weighted rather than measured: the boot is a handful of fetches with
  // wildly different costs, and a bar that moves per phase is what tells the
  // user the last session is coming back.
  // The browser target runs a long pre-mount boot (profiles, OPFS, seeding,
  // git clone) behind its own splash and sets `__bobBootFloor`; start there so
  // the bar continues from the handover instead of resetting to 0.
  const floor =
    typeof window === "undefined"
      ? 0
      : Math.min(
          99,
          Math.max(0, Number((window as unknown as { __bobBootFloor?: number }).__bobBootFloor) || 0),
        );
  const boot = (bootStatus: string, bootProgress?: number) =>
    setState(
      bootProgress === undefined
        ? { bootStatus }
        : { bootStatus, bootProgress: Math.round(floor + (bootProgress * (100 - floor)) / 100) },
    );

  // Which host is this page on? The admin answers {admin:true}; the in-browser
  // backend mirrors the boot-time servedByAdmin() signal and the static-only
  // listener answers 503 — either way, false means "no server": the Telegram
  // controls and audio transcription stay visible but disabled.
  boot("checking the server…", 0);
  try {
    const r = await fetch("/api/capabilities");
    const caps = r.ok ? await r.json() : null;
    setState("adminOnline", !!caps && caps.admin === true);
    // `mode: "browser"` comes from the in-tab backend; the admin answers
    // without it. Only the browser target can bridge to OPFS.
    setState("browserMode", !!caps && caps.mode === "browser");
  } catch {
    setState("adminOnline", false);
  }
  boot("loading apps and models…", 10);
  await Promise.all([refreshApps(), refreshPatterns(), refreshModels()]);
  // Profile-level board exceptions are applied once the app catalog is known.
  applyProfileVisibleExceptions();
  boot("loading apps and models…", 25);
  // The URL carries the open chat. A reload is an explicit pick, so
  // `?session=<key>` resumes that conversation — restoring its turns, memory
  // and tree continuation, and surviving a server restart (the server starts
  // with nothing active until a session is chosen). A stale bookmark (a key
  // that no longer exists) falls through to a fresh chat; `refreshSession`
  // then rewrites the URL to whatever we actually landed on, so it self-heals.
  let wanted: string | null = null;
  try {
    wanted = new URLSearchParams(location.search).get("session");
  } catch {
    /* no location (test harness) — behave as a plain first load */
  }
  let resumed = false;
  if (wanted) {
    boot("restoring your last session…", 30);
    try {
      await postJSON("/api/session", { key: wanted });
      resumed = true;
    } catch (e) {
      console.warn("session: could not resume", wanted, e);
    }
  }
  // No usable session in the URL: a page load opens a NEW chat. The server's
  // active session (and the Telegram-follow) survive a browser refresh, so
  // without this a plain first visit drops you back into whatever was last on
  // screen. Older sessions stay in the picker for an explicit pick.
  // Mint-or-reuse, so reloading an untouched chat never piles up empty shells.
  // `new: true` also ends the Telegram-follow (same as clicking "new chat");
  // re-enable it in settings when wanted.
  if (!resumed) {
    boot("starting a new chat…", 30);
    try {
      await postJSON("/api/session", { new: true });
      // A plain page load lands on a new chat, so it starts on the same
      // trunk-only board as clicking "new chat" (a resume keeps its layout).
      resetBoardForNewSession();
    } catch (e) {
      console.warn("session:", e);
    }
  }
  boot("loading the conversation…", 40);
  try {
    await refreshSession((step) => {
      if (step === "turns") boot("loading memory…", 70);
      else boot("connecting to the live stream…", 90);
    });
  } catch (e) {
    console.warn("session:", e);
  }
  // Fold the stream away when the window is shrunk to phone width: the auto-hide
  // is transient (not persisted), so a desktop pref survives a resize. Guarded
  // because a test harness has no matchMedia, and registered once — `init` runs
  // again when the browser target remounts the app.
  if (!watchingSmallScreen) {
    watchingSmallScreen = true;
    try {
      const mq = window.matchMedia?.(SMALL_QUERY);
      mq?.addEventListener?.("change", (e) => {
        setSmallScreen(e.matches);
        if (e.matches && state.streamOpen) setStreamOpen(false, false);
        // The lift is a phone gesture; a wider board shows every tile again.
        if (!e.matches) clearFront();
      });
    } catch {
      /* no matchMedia */
    }
  }
  openLiveStream();
  setState({ ready: true, bootStatus: "", bootProgress: 100 });
}
