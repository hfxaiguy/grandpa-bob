/**
 * Pure profile-registry logic (web/src/profiles.ts): name guards, registry
 * validation, seed version tags and immutable patches. Anything that touches
 * OPFS lives in the browser and is covered by `npm --prefix web run smoke:browser`.
 *
 * Run: `npm run test:profiles`.
 */
import assert from "node:assert/strict";
import {
  compactTimestamp,
  isValidProfileId,
  isValidProfileName,
  isValidSeedName,
  parseProfileRegistry,
  patchRegistry,
  patchRegistryById,
  profileSegmentsFor,
  relinkProfileId,
  seedVersionCreatedAt,
  seedVersionTag,
  type ProfileRegistry,
} from "../web/src/profiles.js";

// ── names ────────────────────────────────────────────────────────────────
assert.equal(isValidProfileName("default"), true);
assert.equal(isValidProfileName("travel-2026.1"), true);
assert.equal(isValidProfileName("a_b"), true);
for (const bad of ["", "Bob", "two words", "a/b", "..", ".", "x".repeat(65), null, 7]) {
  assert.equal(isValidProfileName(bad), false, `expected invalid profile name: ${String(bad)}`);
}
assert.equal(isValidSeedName("trunk"), true);
assert.equal(isValidSeedName("latest"), false, "the service reserves /latest");
assert.equal(isValidSeedName("Bad Name"), false);

assert.deepEqual(profileSegmentsFor("default"), ["profiles", "default"]);
assert.throws(() => profileSegmentsFor("../escape"), /invalid profile name/);

// ── registry validation ──────────────────────────────────────────────────
const stale = {
  version: 1,
  profiles: [
    {
      name: "travel",
      createdAt: "2026-10-01T00:00:00.000Z",
      lastUsedAt: "2026-10-02T00:00:00.000Z",
      visibleApps: ["kinit", "email", "kinit", "  "],
      seed: {
        baseUrl: "https://bobswap.example.com/",
        account: "personal",
        seedName: "trunk",
        lastVersion: {
          version: "3f9a1b2c4d5e-20261023T005733Z",
          sha256: "3f9a1b2c4d5e" + "0".repeat(52),
          createdAt: "2026-10-23T00:57:33.870Z",
        },
      },
    },
  ],
};
const parsed = parseProfileRegistry(JSON.parse(JSON.stringify(stale)));
assert.equal(parsed.version, 2, "version 1 migrates to version 2 in memory");
assert.equal(parsed.profiles.length, 2, "default is inserted when missing");
assert.equal(parsed.profiles[0].name, "default");
assert.equal(isValidProfileId(parsed.profiles[0].id), true, "the inserted default gets a UUID");
assert.equal(parsed.profiles[1].name, "travel");
assert.equal(isValidProfileId(parsed.profiles[1].id), true, "existing profiles get UUIDs on migration");
assert.equal(parsed.profiles[1].seed?.baseUrl, "https://bobswap.example.com", "trailing slash trimmed");
assert.equal(parsed.profiles[1].seed?.lastVersion?.version, "3f9a1b2c4d5e-20261023T005733Z");
assert.deepEqual(parsed.profiles[1].visibleApps, ["kinit", "email"], "visible exceptions are trimmed and de-duplicated");

// An explicit empty list is meaningful: it means only trunk is on the board.
const visible = parseProfileRegistry({
  version: 1,
  profiles: [{ name: "default", createdAt: "x", visibleApps: [] }],
});
assert.deepEqual(visible.profiles[0].visibleApps, [], "an empty exception list is preserved");
const badVisible = parseProfileRegistry({
  version: 1,
  profiles: [{ name: "default", createdAt: "x", visibleApps: "email" }],
});
assert.equal(badVisible.profiles[0].visibleApps, undefined, "a non-array exception list is ignored");

// Version 2 keeps explicit ids and repairs a missing one instead of dropping
// the whole registry.
const ids = parseProfileRegistry({
  version: 2,
  profiles: [
    { id: "11111111-1111-4111-8111-111111111111", name: "default", createdAt: "x" },
    { name: "travel", createdAt: "y" },
  ],
});
assert.equal(ids.profiles[0].id, "11111111-1111-4111-8111-111111111111");
assert.equal(isValidProfileId(ids.profiles[1].id), true);
const relinked = relinkProfileId(ids, ids.profiles[1].id, "22222222-2222-4222-8222-222222222222");
assert.equal(relinked.profiles[1].id, "22222222-2222-4222-8222-222222222222");
assert.throws(() => relinkProfileId(ids, ids.profiles[1].id, ids.profiles[0].id), /already exists/);

// Idempotent round-trip.
assert.deepEqual(parseProfileRegistry(JSON.parse(JSON.stringify(parsed))), parsed);

const invalid: unknown[] = [
  null,
  "registry",
  {},
  { version: 3, profiles: [] },
  { version: 2 },
  { version: 2, profiles: "x" },
  { version: 2, profiles: [null] },
  { version: 2, profiles: [{ createdAt: "x" }] },
  { version: 2, profiles: [{ name: "Bad Name", createdAt: "x" }] },
  {
    version: 2,
    profiles: [
      { name: "default", createdAt: "x" },
      { name: "default", createdAt: "y" },
    ],
  },
];
for (const value of invalid) {
  assert.throws(() => parseProfileRegistry(value), /registry|version|profiles|profile|name|duplicate/i);
}

// A binding with invalid segments is dropped, not fatal.
const dropped = parseProfileRegistry({
  version: 1,
  profiles: [{ name: "default", createdAt: "x", seed: { baseUrl: "https://x", account: "../x", seedName: "trunk" } }],
});
assert.equal(dropped.profiles[0].seed, undefined);

// ── version tags ─────────────────────────────────────────────────────────
assert.equal(compactTimestamp("2026-10-23T00:57:33.870Z"), "20261023T005733Z");
assert.equal(compactTimestamp("2026-01-02T03:04:05Z"), "20260102T030405Z");
assert.throws(() => compactTimestamp("not a date"), /invalid timestamp/);

const sha = "3f9a1b2c4d5e6f708192a3b4c5d6e7f8";
assert.equal(seedVersionTag(sha, "2026-10-23T00:57:33.870Z"), "3f9a1b2c4d5e-20261023T005733Z");
assert.equal(seedVersionTag(sha.toUpperCase(), "2026-10-23T00:57:33.870Z"), "3f9a1b2c4d5e-20261023T005733Z");
assert.throws(() => seedVersionTag("xyz", "2026-10-23T00:57:33.870Z"), /invalid sha256/);
assert.equal(
  seedVersionCreatedAt("3f9a1b2c4d5e-20261023T005733Z"),
  "2026-10-23T00:57:33Z",
  "a version tag carries the archive's build time",
);
assert.equal(seedVersionCreatedAt("no timestamp"), null);
assert.equal(seedVersionCreatedAt("3f9a1b2c4d5e-20261340T005733Z"), null);

// ── immutable patches ────────────────────────────────────────────────────
const registry: ProfileRegistry = {
  version: 2,
  profiles: [
    { id: "11111111-1111-4111-8111-111111111111", name: "default", createdAt: "a" },
    { id: "22222222-2222-4222-8222-222222222222", name: "work", createdAt: "b" },
  ],
};
const touched = patchRegistry(registry, "work", (record) => ({ ...record, lastUsedAt: "now" }));
assert.equal(touched.profiles[1].lastUsedAt, "now");
assert.equal(registry.profiles[1].lastUsedAt, undefined, "the input registry is not mutated");

const byId = patchRegistryById(registry, "22222222-2222-4222-8222-222222222222", (record) => ({
  ...record,
  name: "travel",
}));
assert.equal(byId.profiles[1].name, "travel");

const removed = patchRegistry(touched, "work", () => null);
assert.deepEqual(removed.profiles.map((p) => p.name), ["default"]);
assert.throws(() => patchRegistry(removed, "work", (r) => r), /unknown profile/);

console.log("profiles test: all assertions passed");
