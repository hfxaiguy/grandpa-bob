/** App state + actions, shared by every component. A module-level Solid store
 *  keeps the tree simple: one screen follows one session, exactly like the old
 *  chat page, but the stream is split per app. */
import { createStore, produce, reconcile } from "solid-js/store";
import { getJSON, postJSON, postForm, openEventStream } from "./api";
import type { AppInfo, PatternInfo, SessionInfo, Slot, Turn } from "./types";

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
  turns: Turn[];
  awaiting: string | null;
  memory: Record<string, Record<string, unknown>>;
  connected: boolean;
  toast: string;
  toastErr: boolean;
  /** The most recent failure (a failed turn or a failed model call), shown
   *  as a dismissible banner. */
  lastError: { title: string; text: string } | null;
  layout: Layout;
}

const LAYOUT_KEY = "gpb.tiled.layout";

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
  turns: [],
  awaiting: null,
  memory: {},
  connected: false,
  toast: "",
  toastErr: false,
  lastError: null,
  layout: loadLayout(),
});

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout));
  } catch {
    /* ignore */
  }
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
    const d = await getJSON<{ slots: Slot[]; models: Record<string, string> }>("/api/models/slots");
    setState("slots", d.slots || []);
    setState("models", reconcile(d.models || {}));
  } catch (e) {
    console.warn("models:", e);
  }
}

export async function refreshMemory(): Promise<void> {
  try {
    const q = state.active ? `?session=${encodeURIComponent(state.active)}` : "";
    const d = await getJSON<{ apps: Record<string, Record<string, unknown>> }>(`/api/tree/memory${q}`);
    setState("memory", d.apps || {});
  } catch {
    setState("memory", {});
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
  setState({
    active: d.active,
    label: d.label || "",
    follow: !!d.follow,
    awaiting: d.awaiting ?? null,
    sessions: d.sessions || [],
    turns: d.turns || [],
  });
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

/** Transcribe a recorded voice blob via /api/transcribe; returns the text. */
export async function transcribeAudio(blob: Blob, filename: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", blob, filename);
  const d = await postForm<{ text: string }>("/api/transcribe", fd);
  return d.text;
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

function handleSSE(msg: any): void {
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
            if (msg.emits) t.emits = msg.emits;
            if (msg.levels) t.levels = msg.levels;
            if (msg.emitApps) t.emitApps = msg.emitApps;
            if (msg.buttons) t.buttons = msg.buttons;
            t.fallback = msg.fallback ?? null;
          }
          s.awaiting = msg.awaiting ?? null;
        }),
      );
      if (msg.status === "error") {
        toast(`turn failed: ${msg.error || "the turn failed"}`, true);
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
      // Memory is scoped per conversation: ignore a push for a session that is
      // not the one on screen (a followed/mirrored turn can arrive mid-switch).
      if (!msg.app || !msg.values) break;
      if (msg.session && state.active && msg.session !== state.active) break;
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

/** Boot the UI: load catalogs, then follow the live stream. */
export async function init(): Promise<void> {
  await Promise.all([refreshApps(), refreshPatterns(), refreshModels()]);
  try {
    await refreshSession();
  } catch (e) {
    console.warn("session:", e);
  }
  await refreshVersions();
  openEventStream(handleSSE, (connected) => setState("connected", connected));
  setState("ready", true);
}
