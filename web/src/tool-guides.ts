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
      "git_push — it pushes the branch you are on (pass branch only to override); the " +
      "workspace's sync branch is 'main'. If push reports that no " +
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
  {
    tools: ["sql_query", "sql_write"],
    guide:
      "APP-OWNED DATABASES: some stores belong to an app tree — contacts.db / comms.db " +
      "to the contacts tree, email.db to the email tree. Reach them by calling that tree; " +
      "a direct sql_query / sql_write against an app's store is refused with a pointer to " +
      "the app. Databases no app owns (ad-hoc .db files) are yours to query directly.",
  },
  {
    tools: ["csv_query"],
    guide:
      "QUERYING A CSV: csv_query runs read-only SQLite SQL over ONE .csv/.tsv file, loaded as the " +
      "table `csv`. PRAGMA table_info(csv) lists the columns. Ask for aggregates (COUNT / SUM / " +
      "GROUP BY) rather than SELECT * — at most 100 rows come back, though rowCount reports the " +
      "full match count and truncated says whether rows were withheld. Numbers are stored as " +
      "numbers (leading-zero ids stay text); everything else is text. One statement per call.",
  },
  {
    tools: ["read_json"],
    guide:
      "READING JSON: read_json parses content that is (or might be) JSON instead of returning raw " +
      'text. Pass exactly one source — "path" for a workspace file, "text" for a JSON string already ' +
      'in context, or "ref" for a ref://<tool>.<seq> handle to a truncated tool result (the full ' +
      "value stays in the log; a string payload is parsed). The result is { json: <value> }: a " +
      "structured value, so a big one comes back as a ref:// handle and rows stay whole. Reach one " +
      'part with "at", a /-separated walk of object keys and array indices (at "rows/0/email"; a ref ' +
      "may carry the same path itself, and at composes after it). Strict JSON only: on a parse error " +
      "the message says why — content that looks like JSONL needs read_file, not this tool. Prefer " +
      "read_json over read_file whenever the file is JSON.",
  },
  {
    tools: ["write_file", "edit_file"],
    guide:
      "APP UI COMPONENTS: an app tree can render a visual component in the web chat instead of a text " +
      'bubble. Put the component beside the app\'s tree as `app/<name>/ui.mjs` (a nested sub-app keeps its ' +
      'own `app/<parent>/app/<child>/ui.mjs`). Attach it with the portable emit shape: ' +
      '`Emit({ text: "Keith · 3 calls", component: "ui.mjs", props: { who: "Keith", count: 3 } })` — ' +
      "`text` is what Telegram and every non-rendering surface show, and `props` is what the component " +
      'renders. The module default-exports `render(root, props, api)`: `api.action(value)` feeds `value` ' +
      'back as the user\'s reply. In BOB\'s browser host the sugar `Emit(data, component("ui.mjs"))` also ' +
      'works (import `{ component }` from "bob/ui"), but that import is browser-only; use the plain object ' +
      "shape when the tree must run under `node --test`. Components are single-file (the sandbox imports " +
      "one module, so no sibling imports) and run in a sandboxed iframe: plain DOM only, and the host " +
      "palette arrives as `--bob-fg`, `--bob-card`, `--bob-border`, `--bob-accent`, `--bob-font`, " +
      "`--bob-font-size`. Keep the component a pure function of `props`.",
  },
  {
    tools: ["inspect_memory"],
    guide:
      "INSPECTING A HANDLE: a truncated tool result carries a ref://<name>.<seq> " +
      "handle for the full value, and live memory slots are addressable by name. " +
      "When you need to see inside one before deciding — how many rows, or what a " +
      "few of them look like — call inspect_memory with { ref } (or { name } for a " +
      "live slot, or a path to walk in). It returns a small sampled view, not the " +
      "whole value, so the list never enters context. To hand the whole value to " +
      "another tree, pass the ref string on unchanged; never invent a ref. Use " +
      '{ name: "*" } to list the slots in scope.',
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
