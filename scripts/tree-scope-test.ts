/**
 * Tool scoping for nested app trees.
 *
 * Discovery tags each nested app with its nearest runnable parent. The host
 * then grants that parent its direct sub-apps as tools, while the trunk (and
 * every other non-app pattern) stays blind to them. This is pure tree-shape
 * logic — no workspace, no engine. Run: `npm run test:tree-scope`.
 */
import assert from "node:assert/strict";
import { scopeTreeTools, type ScopedTree } from "../web/src/agent/tree-scope.js";

const apps = [
  { name: "contacts", parent: null },
  { name: "contacts.graph", parent: "contacts" },
  { name: "contacts.graph.inner", parent: "contacts.graph" },
  { name: "email", parent: null },
  { name: "email.thread", parent: "email" },
];

// ── the trunk sees top-level apps only ────────────────────────────────────
const trunk: ScopedTree = {
  name: "trunk",
  tools: [{ cond: null, value: ["contacts", "contacts.graph", "email", "email.thread", "inspect_memory"] }],
  children: [
    { name: "turn", tools: [{ cond: null, value: ["contacts.graph", "email.thread", "read_json"] }] },
  ],
};
scopeTreeTools(trunk, apps);
assert.deepEqual(
  trunk.tools?.[0].value,
  ["contacts", "email", "inspect_memory"],
  "a non-app pattern loses every sub-app tool",
);
assert.deepEqual(
  trunk.children?.[0].tools?.[0].value,
  ["read_json"],
  "nested subtree rules are scrubbed too",
);

// ── a parent app gains its direct sub-apps ────────────────────────────────
const contacts: ScopedTree = {
  name: "contacts",
  tools: [{ cond: null, value: ["sql_query", "contacts.graph"], position: 0 }],
};
scopeTreeTools(contacts, apps);
assert.deepEqual(
  contacts.tools?.[0].value,
  ["sql_query", "contacts.graph"],
  "the direct sub-app is granted without duplicating an existing mention",
);

const email: ScopedTree = {
  name: "email",
  tools: [{ cond: null, value: ["send_email"], position: 0 }],
};
scopeTreeTools(email, apps);
assert.deepEqual(
  email.tools?.[0].value,
  ["send_email", "email.thread"],
  "the parent's own tools stay and its child is appended",
);

// ── no unconditional Tools(): grant the children from the start ───────────
const conditional: ScopedTree = {
  name: "email",
  tools: [{ cond: () => true, value: ["send_email"], position: 1 }],
};
scopeTreeTools(conditional, apps);
assert.deepEqual(conditional.tools?.[0], { cond: null, value: ["email.thread"], position: 0 });
assert.deepEqual(conditional.tools?.[1].value, ["send_email"], "the conditional rule is untouched");

// ── an app cannot reach another app's sub-app ─────────────────────────────
const crossed: ScopedTree = {
  name: "contacts",
  tools: [{ cond: null, value: ["contacts.graph", "contacts.graph.inner", "email.thread"], position: 0 }],
};
scopeTreeTools(crossed, apps);
assert.deepEqual(
  crossed.tools?.[0].value,
  ["contacts.graph"],
  "only a direct child survives; a grandchild and a sibling's child are removed",
);

// ── a dashed folder and underscore tree name still match ──────────────────
const dashedApps = [
  { name: "caller-list", parent: null },
  { name: "caller-list.sub", parent: "caller-list" },
];
const caller: ScopedTree = {
  name: "caller_list",
  tools: [{ cond: null, value: ["read_runs"], position: 0 }],
};
scopeTreeTools(caller, dashedApps, "caller_list");
assert.deepEqual(
  caller.tools?.[0].value,
  ["read_runs", "caller-list.sub"],
  "the loaded name and the internal tree name both resolve to the app",
);

// ── a root pattern is never an app, even if its name matches one ──────────
const rootNamedLikeApp: ScopedTree = {
  name: "contacts",
  tools: [{ cond: null, value: ["contacts.graph"], position: 0 }],
};
scopeTreeTools(rootNamedLikeApp, apps, null);
assert.deepEqual(rootNamedLikeApp.tools?.[0].value, [], "a root pattern stays blind to sub-apps");

// ── idempotent: loading the same def again must not duplicate names ────────
const again = scopeTreeTools(contacts, apps);
assert.deepEqual(
  again.tools?.[0].value,
  ["sql_query", "contacts.graph"],
  "scoping a cached tree twice is safe",
);

// ── a tree-less container's children already resolve to the nearest ancestor ─
// (listAppTrees tags them with that ancestor, so the normal parent rule applies)
const flattened = [
  { name: "studio", parent: null },
  { name: "studio.widget", parent: "studio" },
];
const studio: ScopedTree = { name: "studio", tools: [{ cond: null, value: [], position: 0 }] };
scopeTreeTools(studio, flattened);
assert.deepEqual(studio.tools?.[0].value, ["studio.widget"], "nearest runnable ancestor drives its sub-app");

console.log("tree-scope: trunk sees top-level apps; parents get their direct sub-apps ok");
