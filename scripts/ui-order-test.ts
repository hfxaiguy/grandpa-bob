/**
 * Tile order: pins stay put, unpinned tiles float by recent activity, and hidden
 * tiles park in the left rail in board order. New chats open on trunk alone;
 * active apps raise their parked tiles while two app seats are free, and a
 * denied raise pulses that app's rail square.
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

const {
  state,
  setState,
  orderedApps,
  hiddenApps,
  togglePinned,
  toggleHidden,
  moveTile,
  handleSSE,
  toggleSub,
  subApps,
  openSubApps,
  parkAllExcept,
  applyProfileVisibleExceptions,
  resetBoardForNewSession,
} = await import("../ui/src/store.ts");

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

// ── a new session opens on a trunk-only board ───────────────────────────
// New session parks every board tile except trunk; active apps raise their
// tiles later (below). Parented apps stay out of the board rail either way.
setState("apps", [
  ...apps,
  { name: "contacts", description: "" },
  { name: "files", description: "" },
  { name: "email", description: "" },
  { name: "kinit", description: "" },
  { name: "files.sub", description: "", parent: "files" },
]);
setState("layout", "hidden", ["contacts", "beta", "email"]);
parkAllExcept();
assert.deepEqual(
  [...state.layout.hidden].sort(),
  ["alpha", "beta", "contacts", "email", "files", "gamma", "kinit"],
  "every app except trunk parks in the rail",
);
assert.deepEqual(order(), ["trunk"], "only trunk stays on the board");
assert.ok(!rail().includes("files.sub"), "a parented app never parks on the board rail");

// ── active apps raise their tiles, up to two beside trunk ───────────────
// The first two apps to run take the two app seats; the third stays in the
// rail (its square pulses) instead of evicting a tile the user may be reading.
handleSSE({ type: "turn_start", session: "web:t", turnId: "raise-a", input: "hi", inputApp: "alpha", ts: 20_000 });
assert.ok(order().includes("alpha"), "an active app raises its parked tile");
handleSSE({ type: "event", turnId: "raise-a", event: { kind: "tree_enter", app: "beta", ts: 20_001 } });
assert.ok(order().includes("beta"), "a second active app raises its tile");
handleSSE({ type: "event", turnId: "raise-a", event: { kind: "tree_enter", app: "gamma", ts: 20_002 } });
assert.ok(!order().includes("gamma"), "a third active app keeps its rail seat");
assert.equal(state.raiseDenied, "gamma", "the denied tile pulses in the rail");

// A manual open is never capped, and it answers the pulse.
toggleHidden("gamma");
assert.ok(order().includes("gamma"), "a manual open is not capped");
assert.equal(state.raiseDenied, null, "opening the tile clears the pulse");

// Activity inside a sub-app raises the parent tile that carries it.
toggleHidden("alpha");
toggleHidden("beta");
handleSSE({ type: "event", turnId: "raise-a", event: { kind: "tree_enter", app: "files.sub", ts: 20_003 } });
assert.ok(!order().includes("files.sub"), "a sub-app never boards itself");
assert.ok(order().includes("files"), "activity in a sub-app raises its parent tile");

// ── a profile's "hidden… except:" list replaces the trunk-only board ────
// Without a list, new chats open on trunk alone (above). With one, exactly
// those tiles stay visible — everything else parks, including kinit/email.
(globalThis as unknown as { window: { __bobProfileVisibleApps?: string[] | null } }).window = {
  __bobProfileVisibleApps: ["contacts", "files"],
};
resetBoardForNewSession();
assert.deepEqual(
  [...state.layout.hidden].sort(),
  ["alpha", "beta", "email", "gamma", "kinit"],
  "every app outside the profile's exceptions parks",
);
assert.deepEqual(
  [...order()].sort(),
  ["contacts", "files", "trunk"].sort(),
  "only the listed exceptions join trunk",
);
assert.ok(!order().includes("kinit") && !order().includes("email"), "kinit and email are hidden by default");

// A boot re-applies the exceptions over a saved layout.
setState("layout", "hidden", ["beta"]);
applyProfileVisibleExceptions();
assert.deepEqual(
  [...state.layout.hidden].sort(),
  ["alpha", "beta", "email", "gamma", "kinit"],
  "boot hides everything the profile did not list",
);
assert.deepEqual(
  [...order()].sort(),
  ["contacts", "files", "trunk"].sort(),
  "manual shows do not outlive a profile's exceptions",
);

// The exceptions can name any apps; only those stay on the board.
(globalThis as unknown as { window: { __bobProfileVisibleApps?: string[] | null } }).window = {
  __bobProfileVisibleApps: ["kinit", "email"],
};
resetBoardForNewSession();
assert.deepEqual([...order()].sort(), ["email", "kinit", "trunk"].sort(), "the listed exceptions stay visible");

// An empty explicit list means trunk alone.
(globalThis as unknown as { window: { __bobProfileVisibleApps?: string[] | null } }).window = {
  __bobProfileVisibleApps: [],
};
resetBoardForNewSession();
assert.deepEqual(order(), ["trunk"], "an empty exception list leaves only trunk");

console.log("ui-order: pinned-first order, activity ranking, rail order, live bumps, auto-raise seats, profile exceptions and the trunk-only new-session board ok");
