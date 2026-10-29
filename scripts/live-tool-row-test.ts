/**
 * Live tool activity under the running turn's last message.
 *
 * The chat row folds a running turn's event list into "current tool" (from
 * `tool_start`, which the engine now emits before executing) plus "last
 * finished tool" (from `tool_result`/`tool_call`/`tool_error`). It must:
 *  - clear the in-flight call the moment its completion row arrives,
 *  - keep the completed call visible as the muted line beneath,
 *  - attribute nested app runs to their own tile, never the caller's,
 *  - show nothing once the turn is over.
 *
 * Run: `npm run test:live-tool-row`.
 */
import assert from "node:assert/strict";
import { liveActivity, toolLabel } from "../ui/src/live-tool.ts";
import type { SanitizedEvent, Turn } from "../ui/src/types.ts";

const ev = (
  kind: string,
  content: Record<string, unknown> | null,
  seq: number,
  app = "trunk",
): SanitizedEvent => ({
  kind,
  branch_path: "",
  iteration: 0,
  scope_id: null,
  content,
  ts: seq,
  seq,
  app,
});

const turn = (events: SanitizedEvent[], status: Turn["status"] = "running"): Turn => ({
  turnId: "t1",
  input: "do it",
  startedAt: 1,
  endedAt: null,
  status,
  error: null,
  output: null,
  events,
});

const apps = ["contacts"];

// ── in-flight call ─────────────────────────────────────────────────────
{
  const t = turn([ev("llm_start", { child: "main", model: "m" }, 1)]);
  const before = liveActivity(t, "trunk", apps);
  assert.equal(before.current, null, "a model call in flight has no tool yet");
  assert.equal(before.lastDone, null);

  t.events.push(ev("tool_start", { child: "main", round: 1, tool: "shell", args: { cmd: "git status" } }, 2));
  const started = liveActivity(t, "trunk", apps);
  assert.deepEqual(started.current, { tool: "shell", args: '{"cmd":"git status"}', ts: 2 });
  assert.equal(started.lastDone, null, "nothing has completed yet");
}

// ── completion moves current → lastDone ────────────────────────────────
{
  const t = turn([
    ev("tool_start", { tool: "shell", args: "git status" }, 1),
    ev("tool_result", { tool: "shell", args: "git status", result: "clean", isError: false }, 2),
  ]);
  const done = liveActivity(t, "trunk", apps);
  assert.equal(done.current, null, "the in-flight row clears when the result lands");
  assert.deepEqual(done.lastDone, { tool: "shell", args: "git status", ts: 2, isError: false });
}

// ── the next call keeps the previous one visible beneath it ────────────
{
  const t = turn([
    ev("tool_start", { tool: "shell", args: "git status" }, 1),
    ev("tool_result", { tool: "shell", args: "git status", result: "clean" }, 2),
    ev("llm_start", { child: "main", model: "m", round: 2 }, 3),
    ev("tool_start", { tool: "read_file", args: { path: "src/index.ts" } }, 4),
  ]);
  const mid = liveActivity(t, "trunk", apps);
  assert.equal(mid.current?.tool, "read_file");
  assert.equal(mid.lastDone?.tool, "shell");

  // The Call() path logs `tool_call` after the fact (no tool_result row).
  t.events.push(ev("tool_call", { tool: "read_file", args: { path: "src/index.ts" }, result: "ok" }, 5));
  const after = liveActivity(t, "trunk", apps);
  assert.equal(after.current, null);
  assert.equal(after.lastDone?.tool, "read_file");
  assert.equal(after.lastDone?.isError, false);
}

// ── failures keep their error flag ─────────────────────────────────────
{
  const t = turn([
    ev("tool_start", { tool: "shell", args: "false" }, 1),
    ev("tool_result", { tool: "shell", args: "false", result: "exit 1", isError: true }, 2),
  ]);
  assert.equal(liveActivity(t, "trunk", apps).lastDone?.isError, true);

  const thrown = turn([
    ev("tool_start", { tool: "shell", args: "nope" }, 1),
    ev("tool_error", { tool: "shell", args: "nope", error: "boom" }, 2),
  ]);
  const e = liveActivity(thrown, "trunk", apps);
  assert.equal(e.current, null);
  assert.deepEqual(e.lastDone && { tool: e.lastDone.tool, isError: e.lastDone.isError }, { tool: "shell", isError: true });
}

// ── nested app runs live on their own tile ─────────────────────────────
{
  const t = turn([
    ev("tree_enter", { tool: "contacts" }, 1),
    ev("tool_start", { tool: "contacts_query", args: { q: "ada" } }, 2),
  ]);
  assert.equal(liveActivity(t, "trunk", apps).current, null, "a nested app's tool never shows on trunk");
  assert.equal(liveActivity(t, "contacts", apps).current?.tool, "contacts_query");

  t.events.push(ev("tool_call", { tool: "contacts_query", args: { q: "ada" }, result: "[]" }, 3));
  t.events.push(ev("tree_exit", { tool: "contacts" }, 4));
  const backOnTrunk = liveActivity(t, "trunk", apps);
  assert.equal(backOnTrunk.current, null);
  assert.equal(backOnTrunk.lastDone, null, "the contacts call is not trunk's last-done");
}

// ── finished turns render no live row ──────────────────────────────────
{
  const t = turn([ev("tool_start", { tool: "shell", args: "x" }, 1)], "done");
  assert.deepEqual(liveActivity(t, "trunk", apps), { current: null, lastDone: null });
  assert.deepEqual(liveActivity(null, "trunk", apps), { current: null, lastDone: null });
}

// ── row text is compact and single-line ────────────────────────────────
{
  const args = { query: "x".repeat(300), filter: { a: 1 } };
  const label = toolLabel("sql_query", args);
  assert.match(label, /^sql_query\(\{/);
  assert.ok(label.length < 140, `label should be capped, got ${label.length}`);
  assert.ok(!label.includes("\n"), "no newlines in the row");
  assert.equal(toolLabel("ping", ""), "ping");
  assert.equal(toolLabel("ping", null), "ping");
}

console.log("live-tool-row: ok");
