/**
 * App attribution — which app (tree tool) a turn's event belongs to.
 *
 * Shared by the Node admin (src/admin.ts) and the in-browser backend
 * (web/src/server/local-backend.ts) so both hosts tag the stream identically:
 * events between `tree_enter`/`tree_exit` belong to that app, `tree_suspend`
 * marks the app that owns the human-input pause.
 *
 * The app is the OUTERMOST tree tool on the stack — the one the trunk called.
 * An app's own capability tools (email's `answer`, contacts' `contacts_query`)
 * are tree tools too, but they run *inside* the app and belong to it: a host
 * shows one tile per app, so an event, emit, or pause in a capability must land
 * on the app's tile, never on a tile named after the capability. Apps compose
 * with `From()` (a plain branch, no enter event), and only the trunk calls apps
 * as tools, so stack[0] is always the app.
 */

export interface TurnApps {
  stack: string[];
  current: string;
  suspended: string | null;
}

export function newTurnApps(): TurnApps {
  return { stack: [], current: "trunk", suspended: null };
}

/** The app name carried by a tree_enter/exit/suspend event. */
export function appNameOf(e: unknown): string {
  const c = (e as { content?: { tool?: unknown; tree?: unknown } } | null)?.content;
  if (typeof c?.tool === "string" && c.tool) return c.tool;
  if (typeof c?.tree === "string" && c.tree) return c.tree;
  return "";
}

/**
 * Update a turn's app stack for one event and return the app it belongs to.
 *
 * The app is the OUTERMOST tree tool (`stack[0]`); a nested tree tool is a
 * capability of the app and stays attributed to it. `tree_enter` pushes,
 * `tree_exit` pops back to the app, `tree_suspend` records the app that owns
 * the human-input pause.
 */
export function tagEventApp(st: TurnApps, e: unknown): string {
  const kind = (e as { kind?: string } | null)?.kind;
  const name = appNameOf(e);
  let app = st.current;
  if (kind === "tree_enter" && name) {
    st.stack.push(name);
    st.current = st.stack[0] ?? "trunk";
    app = st.current;
  } else if (kind === "tree_exit" && name) {
    // The leaver's event belongs to the app (the app itself, or a capability
    // that ran inside it); tag it with the app, then pop.
    app = st.stack[0] ?? name;
    const i = st.stack.lastIndexOf(name);
    if (i >= 0) st.stack.splice(i, 1);
    st.current = st.stack[0] ?? "trunk";
  } else if (kind === "tree_suspend" && name) {
    // A pause inside a capability is the app's pause: the app owns the human
    // input, so its tile shows the input box.
    app = st.stack[0] ?? name;
    st.suspended = app;
    st.current = app;
  }
  return app;
}

/**
 * Recompute per-event app tags for a turn loaded from disk (turns recorded
 * before attribution have none). The markers are in the stored stream, so the
 * same walk reconstructs them; `emitApps` lines up with the stored emits when
 * the `emit` events match one-to-one.
 */
export function retagEvents(
  events: { kind?: string; content?: unknown; app?: string }[],
  prior?: TurnApps,
): { emitApps: string[]; awaiting: string | null } {
  const st: TurnApps = prior
    ? { stack: [...prior.stack], current: prior.current, suspended: prior.suspended }
    : newTurnApps();
  const emitApps: string[] = [];
  for (const ev of events) {
    const app = tagEventApp(st, ev);
    ev.app = app;
    if (ev.kind === "emit") emitApps.push(app);
  }
  return { emitApps, awaiting: st.suspended };
}
