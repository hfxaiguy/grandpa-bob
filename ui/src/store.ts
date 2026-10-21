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
}

export interface UiState {
  ready: boolean;
  apps: AppInfo[];
  sessions: SessionInfo[];
  active: string | null;
  label: string;
  follow: boolean;
  patterns: PatternInfo[];
  pattern: string;
  versions: { versions: string[]; prod: string | null; draft: boolean; active: string };
  ref: string;
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
  toast: string;
  toastErr: boolean;
  /** The most recent failure (a failed turn or a failed model call), shown
   *  as a dismissible banner. */
  lastError: { title: string; text: string } | null;
  layout: Layout;
  /** Show emits tagged `machine` in the app chat bubbles. On by default
   *  (faded) so tree input and waiting notes stay discoverable; the toggle
   *  lets the user hide them. */
  showMachine: boolean;
}

const LAYOUT_KEY = "gpb.tiled.layout";
const MACHINE_KEY = "gpb.showMachine";

function loadLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (raw && typeof raw === "object") {
      return {
        order: Array.isArray(raw.order) ? raw.order : [],
        hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
        expanded: Array.isArray(raw.expanded) ? raw.expanded : [],
        wide: Array.isArray(raw.wide) ? raw.wide : [],
      };
    }
  } catch {
    /* private mode / bad json */
  }
  return { order: [], hidden: [], expanded: [], wide: [] };
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
  apps: [],
  sessions: [],
  active: null,
  label: "",
  follow: false,
  patterns: [],
  pattern: "",
  versions: { versions: [], prod: null, draft: false, active: "prod" },
  ref: "",
  slots: [],
  models: {},
  mockOnly: false,
  turns: [],
  awaiting: null,
  memory: {},
  memorySession: null,
  sessionResumed: false,
  connected: false,
  toast: "",
  toastErr: false,
  lastError: null,
  layout: loadLayout(),
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
  } catch (e) {
    console.warn("apps:", e);
  }
}

export async function refreshPatterns(): Promise<void> {
  try {
    const d = await getJSON<{ current: string; ref: string; patterns: PatternInfo[] }>("/api/pattern");
    setState({ patterns: d.patterns, pattern: d.current, ref: d.ref || "" });
  } catch (e) {
    console.warn("patterns:", e);
  }
}

export async function refreshVersions(name?: string): Promise<void> {
  const n = name ?? state.pattern;
  if (!n) return;
  try {
    const d = await getJSON<{ versions: string[]; prod: string | null; draft: boolean; active: string }>(
      `/api/tree/versions?name=${encodeURIComponent(n)}`,
    );
    setState("versions", {
      versions: d.versions || [],
      prod: d.prod ?? null,
      draft: !!d.draft,
      active: d.active || "prod",
    });
  } catch (e) {
    console.warn("versions:", e);
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
 *  (`storage`, `server`, `remote` on the browser target) are preserved. */
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

export async function refreshSession(): Promise<void> {
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
  if (d.active !== previous) setState({ memory: {}, memorySession: null });
  // The address bar follows the screen (and loses the param when the active
  // session is deleted and nothing is selected).
  updateSessionUrl(d.active);
  setState("models", reconcile(d.models || {}));
  syncLastError(d.turns || []);
  await Promise.all([refreshMemory(), refreshModels()]);
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

/**
 * Stream-transcribe an audio file via /api/transcribe-stream. The server sends
 * SSE frames (info → partial* → done | error); `handlers` receives the
 * progress, and the promise resolves with the final transcript.
 */
export async function transcribeFileStream(
  file: File,
  handlers: TranscribeHandlers = {},
): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/transcribe-stream", { method: "POST", body: fd });
  if (!res.ok) {
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("no response stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finalText = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let msg: { type?: string; duration?: number; text?: string; at?: number; error?: string };
        try {
          msg = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (msg.type === "info") handlers.onInfo?.(msg.duration ?? 0);
        else if (msg.type === "partial") handlers.onPartial?.(msg.text ?? "", msg.at);
        else if (msg.type === "done") finalText = msg.text ?? "";
        else if (msg.type === "error") throw new Error(msg.error || "transcription failed");
      }
    }
  }
  if (!finalText) throw new Error("transcription came back empty");
  return finalText;
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
    await refreshSession();
  } catch (e) {
    toast(e instanceof Error ? e.message : "could not start a session", true);
  }
}

export async function deleteSession(key: string): Promise<void> {
  try {
    await postJSON("/api/session", { delete: key });
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
    await Promise.all([refreshSession(), refreshVersions(name)]);
    toast(`pattern: ${name} — conversation cleared`);
  } catch (e) {
    toast(e instanceof Error ? e.message : "pattern switch failed", true);
  }
}

export async function setRef(ref: string): Promise<void> {
  if (!ref || !state.pattern) return;
  try {
    await postJSON("/api/tree/version/active", { name: state.pattern, ref });
    setState("ref", ref);
    toast(`new sessions use: ${state.pattern}${ref !== "prod" ? "@" + ref : " (prod)"}`);
  } catch (e) {
    toast(e instanceof Error ? e.message : "version switch failed", true);
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

/** Push the active session's transcript to the linked Telegram chat. */
export async function sendToTelegram(): Promise<void> {
  try {
    const d = await postJSON<{ key?: string; followWeb?: string | null }>("/api/send-to-telegram", {});
    toast(
      `sent to telegram${d.key ? ` (${d.key})` : ""}` +
        (d.followWeb ? " — that chat now follows this session" : ""),
    );
  } catch (e) {
    toast(e instanceof Error ? e.message : "send to telegram failed", true);
  }
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

// ── layout tweaks ───────────────────────────────────────────────────────

/** Dismiss the global turn-failure banner. */
export function dismissError(): void {
  setState("lastError", null);
}

export function toggleHidden(name: string): void {
  setState("layout", "hidden", (h) => (h.includes(name) ? h.filter((x) => x !== name) : [...h, name]));
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
export function moveTile(from: string, to: string): void {
  if (from === to) return;
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

/** Tiles in display order: trunk + apps, minus hidden, per the saved order. */
export function orderedApps(): AppInfo[] {
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
  return out.filter((a) => !state.layout.hidden.includes(a.name));
}

// ── live stream (SSE) ───────────────────────────────────────────────────

/**
 * The one live subscription. Re-mounting the app (the browser target swaps
 * chat for settings in place) must not stack subscriptions: every subscriber
 * calls handleSSE, so a leak would append each engine event to the same turn
 * twice. Close before re-opening, and close on unmount (mountApp's dispose).
 */
let stream: EventSource | null = null;

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
            events: [],
          });
          s.awaiting = null;
        }),
      );
      break;
    }
    case "event": {
      const ev = msg.event;
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
      setState(
        produce((s) => {
          const t = s.turns.find((x) => x.turnId === msg.turnId);
          if (!t) return;
          if (msg.text) {
            (t.emits ??= []).push(msg.text);
            (t.levels ??= []).push(msg.level ?? null);
            (t.emitApps ??= []).push(msg.app ?? "trunk");
            t.output = t.output ? t.output + "\n\n" + msg.text : msg.text;
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
            if (msg.buttons) t.buttons = msg.buttons;
            if (msg.tokens) t.tokens = msg.tokens;
            t.fallback = msg.fallback ?? null;
          }
          s.awaiting = msg.awaiting ?? null;
        }),
      );
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
  await Promise.all([refreshApps(), refreshPatterns(), refreshModels()]);
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
    try {
      await postJSON("/api/session", { new: true });
    } catch (e) {
      console.warn("session:", e);
    }
  }
  try {
    await refreshSession();
  } catch (e) {
    console.warn("session:", e);
  }
  await refreshVersions();
  openLiveStream();
  setState("ready", true);
}
