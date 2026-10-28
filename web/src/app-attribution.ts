/**
 * App attribution — which app (tree tool) a turn's event belongs to.
 *
 * Shared by the Node admin (src/admin.ts) and the in-browser backend
 * (web/src/server/local-backend.ts) so both hosts tag the stream identically:
 * events between `tree_enter`/`tree_exit` belong to that app, `tree_suspend`
 * marks the app that owns the human-input pause.
 *
 * An APP is a workspace app tree (`app/<name>/tree.prod.mjs`, the names the
 * host gets from `listAppTrees`). A tree tool that is not an app is a
 * CAPABILITY of the app around it (email's `answer`, contacts'
 * `contacts_query`) and belongs to that app: a host shows one tile per app, so
 * an event, emit, or pause in a capability must land on the app's tile, never
 * on a tile named after the capability.
 *
 * Apps can be entered at ANY depth: the trunk calls them directly, and an app
 * may call another app as a tool (enrich-profile's `resolve_contact` calls the
 * contacts app). Every app entry is a tile boundary, so the current app is the
 * TOPMOST boundary on the stack — a nested app run lands on its own tile and
 * its events do not leak onto the calling app's tile.
 *
 * `newTurnApps()` without the workspace's app names keeps the legacy rule (the
 * first tree tool the trunk enters owns the turn; everything nested belongs to
 * it), so a host that has not threaded the registry through still tags the way
 * it always did.
 *
 * A tree can also opt in to its own chat section regardless of the registry:
 * an enter event carrying `ownTile: true` is a boundary too. That is the seam
 * for the engine's future per-tree marker; app-tree roots are boundaries today
 * through the registry.
 */

export interface TurnAppEntry {
  name: string;
  /** This tree opens a tile — an app tree (or a tree marked `ownTile`). */
  boundary: boolean;
}

export interface TurnApps {
  stack: TurnAppEntry[];
  /** The app the next event belongs to: the topmost boundary, else "trunk". */
  current: string;
  /** The app that owns the human-input pause, once one happened. */
  suspended: string | null;
  /** Workspace app-tree names; null = legacy mode (no registry threaded). */
  apps: Set<string> | null;
}

export function newTurnApps(appNames?: Iterable<string>): TurnApps {
  return {
    stack: [],
    current: "trunk",
    suspended: null,
    apps: appNames ? new Set(appNames) : null,
  };
}

/** The app name carried by a tree_enter/exit/suspend event. */
export function appNameOf(e: unknown): string {
  const c = (e as { content?: { tool?: unknown; tree?: unknown } } | null)?.content;
  if (typeof c?.tool === "string" && c.tool) return c.tool;
  if (typeof c?.tree === "string" && c.tree) return c.tree;
  return "";
}

/** True when this entered tree opens its own tile. */
function isBoundary(st: TurnApps, e: unknown, name: string): boolean {
  // The future marker: any tree can declare itself its own chat section. The
  // engine will put `ownTile: true` on the enter event; hosts that have not
  // learned the flag yet are unaffected (it only adds a boundary).
  if ((e as { content?: { ownTile?: unknown } } | null)?.content?.ownTile === true) return true;
  // Legacy mode (no registry threaded): the first tree tool the trunk enters
  // owns the turn; nested tree tools are its capabilities.
  if (!st.apps) return st.stack.length === 0;
  return st.apps.has(name);
}

/** The topmost boundary on the stack — the app the turn is currently "in". */
function topBoundary(stack: TurnAppEntry[]): string {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].boundary) return stack[i].name;
  }
  return "trunk";
}

/**
 * Update a turn's app stack for one event and return the app it belongs to.
 *
 * `tree_enter` pushes and makes the tree (when it is a boundary) the current
 * app; a nested app is a boundary too, so its run lands on its own tile.
 * `tree_exit` tags the leaver's event with the app it closes (an app's own
 * completion belongs to the app; a capability's exit belongs to the app around
 * it), then falls back to the next boundary below. `tree_suspend` records the
 * app that owns the human-input pause — the topmost boundary, so a nested app
 * keeps its own input box.
 */
export function tagEventApp(st: TurnApps, e: unknown): string {
  const kind = (e as { kind?: string } | null)?.kind;
  const name = appNameOf(e);
  let app = st.current;
  if (kind === "tree_enter" && name) {
    st.stack.push({ name, boundary: isBoundary(st, e, name) });
    st.current = topBoundary(st.stack);
    app = st.current;
  } else if (kind === "tree_exit" && name) {
    // The leaver's event belongs to the app it closes; tag it before popping.
    let i = -1;
    for (let j = st.stack.length - 1; j >= 0; j--) {
      if (st.stack[j].name === name) {
        i = j;
        break;
      }
    }
    const leaving = i >= 0 ? st.stack[i] : null;
    const top = topBoundary(st.stack);
    app = leaving?.boundary ? leaving.name : top !== "trunk" ? top : name;
    if (i >= 0) st.stack.splice(i, 1);
    st.current = topBoundary(st.stack);
  } else if (kind === "tree_suspend" && name) {
    // A pause belongs to the app whose tile shows the input box: the topmost
    // boundary at the pause (a nested app owns its own human input).
    const top = topBoundary(st.stack);
    app = top !== "trunk" ? top : name;
    st.suspended = app;
    st.current = app;
  }
  return app;
}

/**
 * Recompute per-event app tags for a turn loaded from disk (turns recorded
 * before attribution have none). The markers are in the stored stream, so the
 * same walk reconstructs them; `emitApps` lines up with the stored emits when
 * the `emit` events match one-to-one. Pass the workspace's app names (or the
 * `prior` state, which already carries them) to tag nested app runs the way
 * the live host did.
 */
export function retagEvents(
  events: { kind?: string; content?: unknown; app?: string }[],
  prior?: TurnApps,
  appNames?: Iterable<string>,
): { emitApps: string[]; awaiting: string | null } {
  const st: TurnApps = prior
    ? {
        stack: prior.stack.map((s) => ({ ...s })),
        current: prior.current,
        suspended: prior.suspended,
        apps: prior.apps,
      }
    : newTurnApps(appNames);
  const emitApps: string[] = [];
  for (const ev of events) {
    const app = tagEventApp(st, ev);
    ev.app = app;
    if (ev.kind === "emit") emitApps.push(app);
  }
  return { emitApps, awaiting: st.suspended };
}
