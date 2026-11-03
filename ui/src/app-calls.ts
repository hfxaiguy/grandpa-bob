/**
 * Inline app calls — the smaller app tiles that appear in a caller's chat.
 *
 * A conversation is not only its own bubbles: when the trunk calls `contacts`,
 * or an app calls one of its sub-apps, the caller's chat should carry a compact
 * card for that call. The card mirrors the app's tile one level down (header,
 * status, emitted bubbles) and can itself carry the app's own sub-calls, so the
 * fractal workspace hierarchy is visible in the conversation where it happened.
 *
 * The fold is pure: it reads the same attributed event stream the tile
 * attribution uses (`web/src/app-attribution.ts`) and the persisted emit arrays
 * (`emits`/`emitApps`), so a live turn and a replayed turn render the same
 * cards.
 */
import {
  appNameOf,
  newTurnApps,
  seedPausedApp,
  tagEventApp,
} from "../../web/src/app-attribution";
import type { AppInfo, Turn } from "./types";

/** The status line of an inline app card. */
export type AppCallStatus = "running" | "waiting" | "done" | "error";

/** One app called from another app's conversation during a turn. */
export interface AppCall {
  /** The called app's logical name (`contacts`, `contacts.graph`, …). */
  app: string;
  /** Emit indices in the turn that this app wrote directly (not its children). */
  emits: number[];
  /** Calls this app made during the same turn, recursively. */
  children: AppCall[];
  status: AppCallStatus;
  /** The app's own tree invocation ended with an engine error. */
  failed: boolean;
  /** First event position, used to order cards against the caller's bubbles. */
  startedAt: number;
}

/** A turn slice the fold needs; the live and replayed shapes both provide it. */
type CallsTurn = Pick<
  Turn,
  "status" | "events" | "emits" | "emitApps" | "awaiting" | "inputApp"
>;

/** The first emit (direct or nested) the card carries, or Infinity for none. */
export function firstEmitIndex(call: AppCall): number {
  let first = call.emits.length ? Math.min(...call.emits) : Infinity;
  for (const child of call.children) first = Math.min(first, firstEmitIndex(child));
  return first;
}

/** A stable identity for bubble reuse: same app, status and contents = same
 *  card (a live emit must not tear down a component iframe it already mounted). */
export function appCallKey(call: AppCall): string {
  return [
    call.app,
    call.status,
    call.failed ? "!" : "",
    call.emits.join(","),
    call.children.map(appCallKey).join(";"),
  ].join("|");
}

/** The workspace hierarchy, as the UI knows it. */
type AppHierarchy = {
  names: Set<string> | null;
  parentOf: ((name: string) => string | null | undefined) | null;
};

function hierarchyOf(apps?: Iterable<Pick<AppInfo, "name" | "parent">>): AppHierarchy {
  if (!apps) return { names: null, parentOf: null };
  const list = [...apps];
  const byName = new Map(list.map((a) => [a.name, a] as const));
  return {
    names: new Set(list.map((a) => a.name)),
    parentOf: (name) => byName.get(name)?.parent ?? null,
  };
}

/** True when `child` sits directly under `parent` in the workspace hierarchy. */
function isDirectChild(h: AppHierarchy, parent: string, child: string): boolean {
  if (!h.parentOf) return true;
  const holder = h.parentOf(child);
  return parent === "trunk" ? !holder : holder === parent;
}

function statusForOpenCall(turn: CallsTurn, app: string, suspended: boolean): AppCallStatus {
  if (turn.status === "running") return suspended ? "waiting" : "running";
  if (turn.status === "error") return "error";
  if (turn.status === "stopped") return "done";
  // A paused turn is persisted as "done" because the browser run resolves at
  // the pause. Every open app around the pause is waiting to be resumed, not
  // finished: an inner app's pause suspends its callers too.
  if (suspended) return "waiting";
  return turn.awaiting === app ? "waiting" : "done";
}

/** The mutable walk state kept beside a card while events are folded. */
interface OpenCall extends AppCall {
  activeSuspend: boolean;
}

/**
 * Every app called directly from `app` during one turn, in first-call order.
 *
 * Event path: `tree_enter` (tagged as a boundary) whose caller was `app` opens
 * a card; `tree_suspend` makes it wait and `tree_exit` closes it. Nested apps
 * are folded afterwards from the called app's own chat, recursively. Old turns
 * without replay events fall back to the persisted `emitApps` tags and the
 * workspace parent map.
 */
export function appCallsFor(
  turn: CallsTurn,
  app: string,
  apps?: Iterable<Pick<AppInfo, "name" | "parent">>,
): AppCall[] {
  return collectCalls(turn, app, hierarchyOf(apps), 0, new Set<string>());
}

function collectCalls(
  turn: CallsTurn,
  app: string,
  h: AppHierarchy,
  depth: number,
  ancestors: Set<string>,
): AppCall[] {
  // The walk must be able to recurse into an app that calls itself (a broken
  // tree, but a chat must not recurse forever); the depth cap bounds it too.
  if (depth > 6) return [];
  const events = turn.events ?? [];
  const calls = new Map<string, OpenCall>();
  const order: string[] = [];

  const ensure = (child: string, startedAt: number): OpenCall => {
    let call = calls.get(child);
    if (!call) {
      call = {
        app: child,
        emits: [],
        children: [],
        status: "running",
        failed: false,
        activeSuspend: false,
        startedAt,
      };
      calls.set(child, call);
      order.push(child);
    }
    return call;
  };

  if (events.length) {
    const st = newTurnApps(h.names ?? undefined);
    seedPausedApp(st, turn.inputApp);
    for (const ev of events) {
      const before = st.current;
      const tagged = tagEventApp(st, ev);
      const name = appNameOf(ev);
      if (ev.kind === "tree_enter" && name && tagged === name) {
        // Only a boundary directly below this chat opens a card here. A
        // capability (contacts_query, email's answer, …) keeps the caller as
        // the current app and stays inside the caller's own bubbles. A resumed
        // turn seeds the paused app as the current boundary, so its own
        // re-entry must not become a card inside itself.
        if (before !== app || name === app) continue;
        if (h.names && !h.names.has(name)) continue;
        const call = ensure(name, seqOf(ev));
        call.status = "running";
        call.failed = false;
        call.activeSuspend = false;
      } else if (ev.kind === "tree_suspend" && name && calls.has(name)) {
        const call = calls.get(name)!;
        call.status = "waiting";
        call.activeSuspend = true;
      } else if (ev.kind === "tree_exit" && name && calls.has(name)) {
        const call = calls.get(name)!;
        call.failed = (ev.content as { error?: unknown } | null)?.error === true;
        call.status = call.failed ? "error" : "done";
        call.activeSuspend = false;
      }
    }
  }

  // Emits are the durable source of truth (the marker keeps them even when the
  // event tail was capped). When the event walk already found a call, these
  // just fill its bubbles. A direct child that appears only in `emitApps` is a
  // call whose enter row fell outside the tail (or an old turn without replay).
  const emitApps = turn.emitApps ?? [];
  const emits = turn.emits ?? [];
  const count = Math.min(emitApps.length, emits.length);
  for (let i = 0; i < count; i++) {
    const child = emitApps[i] || "trunk";
    if (child === app) continue;
    if (h.names && !h.names.has(child)) continue;
    if (!events.length || !calls.has(child)) {
      // With no hierarchy at all (tests/legacy), accept any non-self app; with
      // one, only a direct child belongs in this chat.
      if (h.parentOf && !isDirectChild(h, app, child)) continue;
      ensure(child, i).emits.push(i);
    } else {
      calls.get(child)!.emits.push(i);
    }
  }

  // A turn that has ended cannot leave a call visually running; a paused app
  // keeps its card in the waiting posture so it matches the tile's composer.
  for (const call of calls.values()) {
    if (call.status === "running" || call.status === "waiting") {
      call.status = statusForOpenCall(turn, call.app, call.activeSuspend);
      if (call.status !== "waiting") call.activeSuspend = false;
    }
  }

  // Recursion: each called app's chat in turn shows the apps it called.
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(app);
  for (const call of calls.values()) {
    call.children = nextAncestors.has(call.app)
      ? []
      : collectCalls(turn, call.app, h, depth + 1, nextAncestors);
  }

  return order.map((name) => {
    const { activeSuspend: _ignored, ...card } = calls.get(name)!;
    return card;
  });
}

function seqOf(ev: { seq?: number; ts?: number }): number {
  return Number(ev.seq ?? ev.ts ?? 0);
}
