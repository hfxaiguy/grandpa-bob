/**
 * Button store: short ids for emitted button values.
 *
 * Telegram caps callback_data at 64 bytes, so a button's value is registered
 * server-side and the keyboard carries only "btn:<id>". Ids are scoped to the
 * conversation that registered them, expire after a ttl, and the map is
 * capped so a long-lived process cannot grow it without bound.
 *
 * Run: npm run test:button-store
 */
import assert from "node:assert/strict";
import { ButtonStore } from "../src/buttons.js";

// ── 1. round trip: register an id, resolve it back to the value ──
{
  const store = new ButtonStore();
  const id = store.register("1:0", "yes");
  assert.equal(store.resolve("1:0", id), "yes");
}

// ── 2. ids are unique per registration ──
{
  const store = new ButtonStore();
  const a = store.register("1:0", "yes");
  const b = store.register("1:0", "yes");
  assert.notEqual(a, b);
  assert.equal(store.resolve("1:0", a), "yes");
  assert.equal(store.resolve("1:0", b), "yes");
}

// ── 3. an id only resolves in the conversation that registered it ──
{
  const store = new ButtonStore();
  const id = store.register("1:0", "yes");
  assert.equal(store.resolve("2:0", id), undefined);
  assert.equal(store.resolve("1:0", id), "yes", "the right key still works after a wrong-key miss");
}

// ── 4. unknown ids resolve to undefined ──
{
  const store = new ButtonStore();
  assert.equal(store.resolve("1:0", "nope"), undefined);
}

// ── 5. expired ids stop resolving ──
{
  const store = new ButtonStore(-1);
  const id = store.register("1:0", "yes");
  assert.equal(store.resolve("1:0", id), undefined);
}

// ── 6. the cap drops the oldest ids first ──
{
  const store = new ButtonStore(60_000, 2);
  const a = store.register("1:0", "a");
  const b = store.register("1:0", "b");
  const c = store.register("1:0", "c");
  assert.equal(store.resolve("1:0", a), undefined);
  assert.equal(store.resolve("1:0", b), "b");
  assert.equal(store.resolve("1:0", c), "c");
}

// ── 7. callback_data stays far under Telegram's 64-byte cap ──
{
  const store = new ButtonStore();
  const id = store.register("1:0", "x".repeat(500));
  assert.ok(("btn:" + id).length <= 64);
}

console.log("button-store-test: register/resolve, scoping, expiry, cap OK");
