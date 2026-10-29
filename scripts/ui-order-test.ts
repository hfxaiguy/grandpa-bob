/**
 * Tile order: pins stay put, unpinned tiles float by recent activity, and hidden
 * tiles park in the left rail in board order.
 *
 * The board is pinned-first (manual order) then most-recently-active. Trunk is
 * pinned by default (including for layouts saved before pins existed); only
 * pinned tiles can be dragged. Activity comes from the live SSE frames, with
 * one guard: a chatty turn must not re-bump the same app on every event.
 *
 * No network (no fetches are touched) and no browser (Solid's store is plain JS).
 * Run: npm run test:ui-order
 */
import assert from "node:assert/strict";

const { state, setState, orderedApps, hiddenApps, togglePinned, toggleHidden, moveTile, handleSSE, toggleSub, subApps, openSubApps, parkAllExcept } = await import(
  "../ui/src/store.ts"
);

const apps = ["trunk", "alpha", "beta", "gamma"].map((name) => ({ name, description: "" }));
setState("apps", apps);
// What loadLayout() gives a board with no saved layout: trunk pinned.
setState("layout", { order: [], hidden: [], expanded: [], wide: [], pinned: ["trunk"], subsOpen: [], memClosed: [] });

const order = () => orderedApps().map((a) => a.name);
const rail = () => hiddenApps().map((a) => a.name);

assert.deepEqual(order(), ["trunk", "alpha", "beta", "gamma"], "base order is the server order");

// Recent activity floats unpinned tiles up; pinned trunk does not move.
setState("activity", { gamma: 200, beta: 100 });
assert.deepEqual(order(), ["trunk", "gamma", "beta", "alpha"], "activity floats unpinned tiles");

// A new pin anchors after the existing pins, not above them (empty order would
// otherwise put it first: order entries come before unknown names).
togglePinned("alpha");
assert.deepEqual(state.layout.pinned, ["trunk", "alpha"]);
assert.deepEqual(state.layout.order, ["trunk", "alpha"], "pin anchors into the manual order");
assert.deepEqual(order(), ["trunk", "alpha", "gamma", "beta"], "pin lands after trunk");

// Pinned tiles keep their manual order and can be dragged; unpinned tiles refuse
// a drop (their order is activity's).
moveTile("trunk", "alpha");
assert.deepEqual(order(), ["alpha", "trunk", "gamma", "beta"], "pinned tiles are draggable");
moveTile("gamma", "beta");
assert.deepEqual(order(), ["alpha", "trunk", "gamma", "beta"], "unpinned drop is a no-op");

toggleHidden("beta");
assert.deepEqual(order(), ["alpha", "trunk", "gamma"], "hidden tiles drop out");
assert.deepEqual(rail(), ["beta"], "the rail shows the hidden tile");
toggleHidden("beta");
assert.deepEqual(rail(), [], "restoring empties the rail");

// The rail keeps board order: a hidden pinned tile comes before hidden unpinned
// ones (the same seat it would take on restore).
toggleHidden("alpha"); // pinned
toggleHidden("gamma"); // unpinned
assert.deepEqual(rail(), ["alpha", "gamma"], "rail mirrors board order");
assert.deepEqual(order(), ["trunk", "beta"], "hidden tiles leave the board");
toggleHidden("alpha");
toggleHidden("gamma");

// Unpinning trunk lets it flow with activity (and by base order when it has none).
togglePinned("trunk");
assert.deepEqual(order(), ["alpha", "gamma", "beta", "trunk"], "unpinned trunk falls back");

// More recent activity in the unpinned block, pins untouched.
setState("activity", { beta: 900 });
assert.deepEqual(order(), ["alpha", "beta", "gamma", "trunk"], "pins do not move with activity");

// ── sub-apps never board ────────────────────────────────────────────────
// A parented app parks inside its parent's tile rail — never on the board,
// never on the board's hidden rail, whatever its hidden flag says.
setState("apps", [...apps, { name: "alpha.sub", description: "", parent: "alpha" }]);
assert.deepEqual(order(), ["alpha", "beta", "gamma", "trunk"], "a parented app stays off the board");
assert.deepEqual(rail(), [], "a parented app never parks on the board rail");
setState("layout", "hidden", ["alpha.sub"]);
assert.deepEqual(rail(), [], "hidden excludes parented apps from the board rail");
setState("layout", "hidden", []);
toggleSub("alpha.sub");
assert.deepEqual(state.layout.subsOpen, ["alpha.sub"], "opening a sub records it");
assert.deepEqual(openSubApps("alpha").map((a) => a.name), ["alpha.sub"], "the parent strips its opened subs");
assert.deepEqual(subApps("alpha").map((a) => a.name), ["alpha.sub"], "the parent's rail lists every sub");
toggleSub("alpha.sub");
assert.deepEqual(state.layout.subsOpen, [], "parking a sub removes it again");

// ── live frames ─────────────────────────────────────────────────────────
setState("active", "web:t");

handleSSE({ type: "turn_start", session: "web:t", turnId: "t1", input: "hi", inputApp: "gamma", ts: 5_000 });
assert.equal(state.activity.gamma, 5_000, "turn_start bumps the app the human spoke to");

handleSSE({ type: "event", turnId: "t1", event: { kind: "tree_enter", app: "beta", ts: 5_001 } });
assert.equal(state.activity.beta, 5_001, "an app change bumps that app");
assert.equal(order()[1], "beta", "the running app floats up");

handleSSE({ type: "event", turnId: "t1", event: { kind: "tool_call", app: "beta", ts: 9_999 } });
assert.equal(state.activity.beta, 5_001, "same-app events do not re-bump");

handleSSE({ type: "emit", turnId: "t1", app: "gamma", text: "hello" });
assert.ok(state.activity.gamma > state.activity.beta, "an emit bumps its app");
assert.equal(order()[1], "gamma", "the emitting app floats up");

// ── a new session opens on a quiet board ────────────────────────────────
// New session parks every board tile except trunk, contacts and files. The
// keep list wins over earlier parking (contacts comes back); parented apps
// stay out of the board rail either way.
setState("apps", [
  ...apps,
  { name: "contacts", description: "" },
  { name: "files", description: "" },
  { name: "email", description: "" },
  { name: "files.sub", description: "", parent: "files" },
]);
setState("layout", "hidden", ["contacts", "beta", "email"]);
parkAllExcept();
assert.deepEqual(
  [...state.layout.hidden].sort(),
  ["alpha", "beta", "email", "gamma"],
  "every app except contacts and files parks in the rail",
);
assert.deepEqual(order(), ["trunk", "contacts", "files"], "trunk, contacts and files stay on the board");
assert.ok(!rail().includes("files.sub"), "a parented app never parks on the board rail");

console.log("ui-order: pinned-first order, activity ranking, rail order, live bumps and the new-session board ok");
