// src/tool-guides.ts
//
// Prompt guidance for tools, kept out of the trunk. Each tool/app owns its own
// "how to use me well" text; the registry (Node) and the browser worker both
// assemble it with `assembleGuides`, so the two targets share one source for
// host-tool guidance.
//
// This module is deliberately node-free: the browser build imports it too.

export interface HostGuide {
  /** Tool names this guidance covers; it is included if any is in scope. */
  tools: string[];
  guide: string;
}

/**
 * Guidance owned by host tools (BOB's own tool set). App/tree guides come from
 * the workspace; these are versioned with BOB.
 */
export const HOST_GUIDES: HostGuide[] = [
  {
    tools: ["read_runs"],
    guide:
      'RECALLING THE PAST: the run log records every past session. To answer ' +
      '"what have we been doing", "who did I talk to recently", or "I just spoke ' +
      'to her", call read_runs with type "emit" — the recent emit timeline ' +
      "(what the bot told the user, newest first). By default read_runs returns the " +
      'most recent rows of every kind, so set `type` explicitly ("emit" for what the ' +
      'bot said, "human" for what the user said) and use `limit` / `before` / `after` ' +
      '/ `run_id` to narrow it. Then mode "expanded" with a row\'s seq for the trace ' +
      "behind it (the llm calls, tool calls and results). The emits carry the names the " +
      "apps resolved, so recall does not depend on spelling, and the log is the source " +
      'of truth for "recently", not the current conversation.',
  },
  {
    tools: ["git_status", "git_commit", "git_push", "git_fetch", "git_log"],
    guide:
      "GIT SYNC: the workspace is a git repository (every write_file/edit_file/" +
      "delete_file is committed automatically). When the user asks to sync or push, " +
      "call git_status to see changes, then git_commit with a short message, then " +
      "git_push — it pushes the branch you are on (pass branch only to override), so a " +
      "local 'master' is pushed as master, not forced to 'main'. If push reports that no " +
      "remote is configured, ask the user for the remote URL (never guess one). Never " +
      "force-push or reset.",
  },
  {
    tools: ["git_remote"],
    guide:
      "GIT REMOTES: call git_remote with no arguments to list the remotes plus the current " +
      "branch and its upstream; git_remote { name, url } adds or updates one; " +
      "{ name, remove: true } removes one. A branch name is not a remote — push the branch " +
      "you are on unless told otherwise. Never guess a URL; ask the user.",
  },
];

/**
 * Join the guidance that applies to a set of in-scope tool names:
 *  - a host guide is included when any of its tools is in scope;
 *  - an app/tree guide is included when its name is in scope.
 * An app/tree guide is prefixed with its tool name, so "call this tree" in the
 * guide is unambiguously tied to the tool the model must call. Identical text is
 * deduplicated; the order is host, then tree, then app.
 */
export function assembleGuides(opts: {
  hostGuides?: HostGuide[];
  appGuides?: Map<string, string>;
  treeGuides?: Map<string, string>;
  inScope: Iterable<string>;
}): string {
  const scope = new Set(opts.inScope);
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (text: string) => {
    const t = String(text ?? "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    parts.push(t);
  };
  const addNamed = (name: string, guide: string) => {
    const t = String(guide ?? "").trim();
    if (!t) return;
    add(`Tool "${name}": ${t}`);
  };

  for (const { tools, guide } of opts.hostGuides ?? []) {
    if (tools.some((t) => scope.has(t))) add(guide);
  }
  for (const [name, guide] of [...(opts.treeGuides ?? new Map())].sort(([a], [b]) => a.localeCompare(b))) {
    if (scope.has(name)) addNamed(name, guide);
  }
  for (const [name, guide] of [...(opts.appGuides ?? new Map())].sort(([a], [b]) => a.localeCompare(b))) {
    if (scope.has(name)) addNamed(name, guide);
  }
  return parts.join("\n\n");
}
