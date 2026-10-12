/**
 * App attribution — which app (tree tool) a turn's event belongs to.
 *
 * Shared by the Node admin (src/admin.ts) and the in-browser backend
 * (web/src/server/local-backend.ts) so both hosts tag the stream identically:
 * events between `tree_enter`/`tree_exit` belong to that app, `tree_suspend`
 * marks the app that owns the human-input pause.
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
 * `tree_enter` pushes, `tree_exit` pops back to the parent, `tree_suspend`
 * records the app the turn paused in (the one that owns the human input).
 */
export function tagEventApp(st: TurnApps, e: unknown): string {
  const kind = (e as { kind?: string } | null)?.kind;
  const name = appNameOf(e);
  let app = st.current;
  if (kind === "tree_enter" && name) {
    st.stack.push(name);
    st.current = name;
    app = name;
  } else if (kind === "tree_exit" && name) {
    app = name;
    const i = st.stack.lastIndexOf(name);
    if (i >= 0) st.stack.splice(i, 1);
    st.current = st.stack.at(-1) ?? "trunk";
  } else if (kind === "tree_suspend" && name) {
    app = name;
    st.suspended = name;
    st.current = name;
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
