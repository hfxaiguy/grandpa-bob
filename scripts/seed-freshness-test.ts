// Unit tests for the browser seed-freshness check (web/src/seed-version.ts):
// the comparison that decides whether the toolbar offers a workspace update.
import assert from "node:assert/strict";
import { parseSeedMeta, seedFreshness, SEED_CLOCK_TOLERANCE_MS } from "../web/src/seed-version.ts";
import { parseSeedList } from "../web/src/swap.ts";

const seed = (createdAt: unknown) => parseSeedMeta({ version: 1, createdAt, fileCount: 3 });

// ── parseSeedMeta ────────────────────────────────────────────────────────
assert.equal(parseSeedMeta(null), null, "null payload");
assert.equal(parseSeedMeta("x"), null, "string payload");
assert.equal(parseSeedMeta({}), null, "missing createdAt");
assert.equal(parseSeedMeta({ createdAt: "not-a-date" }), null, "invalid createdAt");
assert.deepEqual(parseSeedMeta({ version: 1, createdAt: "2026-10-22T00:30:52Z", fileCount: 194 }), {
  version: 1,
  createdAt: "2026-10-22T00:30:52Z",
  fileCount: 194,
  sha256: undefined,
  size: undefined,
});
assert.deepEqual(parseSeedMeta({ createdAt: "2026-10-22T00:30:52Z" }), {
  version: undefined,
  createdAt: "2026-10-22T00:30:52Z",
  fileCount: undefined,
  sha256: undefined,
  size: undefined,
});

// Packer-recorded content hash + size (lowercased; malformed values dropped).
const digest = "a1".repeat(32);
assert.deepEqual(
  parseSeedMeta({
    version: 1,
    createdAt: "2026-10-22T00:30:52Z",
    fileCount: 194,
    sha256: digest.toUpperCase(),
    size: 4096,
  }),
  {
    version: 1,
    createdAt: "2026-10-22T00:30:52Z",
    fileCount: 194,
    sha256: digest,
    size: 4096,
  },
);
assert.equal(parseSeedMeta({ createdAt: "2026-10-22T00:30:52Z", sha256: "nope" })?.sha256, undefined);
assert.equal(parseSeedMeta({ createdAt: "2026-10-22T00:30:52Z", size: "big" })?.size, undefined);

// ── seedFreshness ────────────────────────────────────────────────────────
const built = "2026-10-22T00:30:52.000Z";

assert.equal(seedFreshness(null, seed(built)), "unknown", "no marker: fresh profile");
assert.equal(seedFreshness("", seed(built)), "unknown", "empty marker");
assert.equal(seedFreshness("garbage", seed(built)), "unknown", "unreadable marker");
assert.equal(seedFreshness("2026-10-15T00:00:00Z", null), "unknown", "no seed meta");

// The trap this check exists for: seeded Oct 15, seed rebuilt Oct 22.
assert.equal(seedFreshness("2026-10-15T12:00:00Z", seed(built)), "newer", "stale workspace");

// Just applied this seed (apply-time stamp after build time): current.
assert.equal(
  seedFreshness("2026-10-22T00:31:30Z", seed(built)),
  "current",
  "workspace stamped after its seed was built",
);
// Clock skew inside the tolerance must not offer an update.
assert.equal(
  seedFreshness(new Date(Date.parse(built) + SEED_CLOCK_TOLERANCE_MS - 1000).toISOString(), seed(built)),
  "current",
  "within skew tolerance",
);
// A manual import newer than the shipped seed stays current.
assert.equal(seedFreshness("2026-10-23T09:00:00Z", seed(built)), "current", "imported a newer workspace");
// Exactly one tolerance past the build does count as newer.
assert.equal(
  seedFreshness(new Date(Date.parse(built) + SEED_CLOCK_TOLERANCE_MS).toISOString(), seed(built)),
  "current",
  "tolerance boundary is inclusive (not newer)",
);
assert.equal(
  seedFreshness(new Date(Date.parse(built) + SEED_CLOCK_TOLERANCE_MS + 1000).toISOString(), seed(built)),
  "current",
  "workspace still ahead",
);

// ── content-hash freshness (re-packed same-day seeds) ────────────────────
const hashed = parseSeedMeta({
  version: 1,
  createdAt: built,
  sha256: "b1".repeat(32),
});
const otherSha = "c2".repeat(32);

assert.equal(
  seedFreshness(built, hashed, SEED_CLOCK_TOLERANCE_MS, "b1".repeat(32).toUpperCase()),
  "current",
  "matching hash is current even when the timestamps are identical",
);
assert.equal(
  seedFreshness(built, hashed, SEED_CLOCK_TOLERANCE_MS, otherSha),
  "newer",
  "a re-packed seed with the same createdAt is still offered (hash differs)",
);
assert.equal(
  seedFreshness("2026-10-30T00:00:00Z", hashed, SEED_CLOCK_TOLERANCE_MS, otherSha),
  "newer",
  "hash wins over a workspace stamped later",
);
assert.equal(
  seedFreshness("2026-10-15T12:00:00Z", hashed, SEED_CLOCK_TOLERANCE_MS, null),
  "newer",
  "no local hash falls back to the timestamp",
);
assert.equal(
  seedFreshness(built, seed(built), SEED_CLOCK_TOLERANCE_MS, otherSha),
  "current",
  "no packer hash falls back to the timestamp",
);

console.log("seed-freshness: all assertions passed");

// ── seed listing (the new-workspace picker) ──────────────────────────────
assert.deepEqual(
  parseSeedList({
    account: "personal",
    seeds: [
      { name: "trunk", latest: "abc123def456-20261023T010000Z", versions: ["v1", "v2"] },
      { name: "notes" },
    ],
  }),
  [
    { name: "notes", versions: [] },
    { name: "trunk", latest: "abc123def456-20261023T010000Z", versions: ["v1", "v2"] },
  ],
  "documented shape is sorted and normalized",
);
assert.deepEqual(
  parseSeedList({
    seeds: [
      { name: "trunk", latest: 7, versions: [1, " ok ", ""] },
      { name: "latest", latest: "reserved" },
      { name: "Bad Name" },
      { name: "trunk" },
      null,
      "x",
    ],
  }),
  [{ name: "trunk", versions: ["ok"] }],
  "unusable names/rows are dropped, duplicates collapse",
);
assert.throws(() => parseSeedList(null), /seed list/);
assert.throws(() => parseSeedList({}), /seeds array/);

