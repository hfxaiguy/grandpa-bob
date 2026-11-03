// Unit tests for the open-seed bootstrap config (web/src/seed-bootstrap.ts):
// the shelf a deployment offers without any BobSwap service configuration.
import assert from "node:assert/strict";
import {
  bootstrapSeedFromParams,
  bootstrapSeedNames,
  parseBootstrapSeed,
  type BootstrapSeed,
} from "../web/src/seed-bootstrap.ts";

// The documented single-seed file still parses unchanged.
assert.deepEqual(
  parseBootstrapSeed({
    baseUrl: "https://bobswap.hfxaiguy.com/",
    account: "personal",
    seedName: "trunk",
  }),
  { baseUrl: "https://bobswap.hfxaiguy.com", account: "personal", seedName: "trunk" },
  "the shipped seed-bootstrap.json shape is accepted",
);

// Missing/invalid path segments are rejected; baseUrl falls back to the
// deployed service when omitted.
assert.equal(parseBootstrapSeed(null), null, "null payload");
assert.equal(parseBootstrapSeed({ account: "personal" }), null, "missing seed name");
assert.equal(parseBootstrapSeed({ account: "Personal", seedName: "trunk" }), null, "invalid account");
assert.equal(parseBootstrapSeed({ account: "personal", seedName: "latest" }), null, "reserved seed name");
assert.deepEqual(
  parseBootstrapSeed({ account: "personal", seedName: "trunk" }),
  {
    baseUrl: "https://bobswap.hfxaiguy.com",
    account: "personal",
    seedName: "trunk",
  },
  "the default service is used when baseUrl is absent",
);

// Additional open names can use either spelling; invalid/duplicate entries are
// dropped and the primary seed stays first.
const shelf = parseBootstrapSeed({
  account: "personal",
  seedName: "trunk",
  openSeeds: ["notes", "Bad Name", "trunk", 7],
  seeds: ["demo", "notes"],
});
assert.deepEqual(
  shelf,
  {
    baseUrl: "https://bobswap.hfxaiguy.com",
    account: "personal",
    seedName: "trunk",
    openSeeds: ["notes", "demo"],
  },
  "openSeeds/seeds are validated, de-duplicated and kept in order",
);
assert.deepEqual(
  bootstrapSeedNames(shelf as BootstrapSeed),
  ["trunk", "notes", "demo"],
  "the primary seed is always offered first",
);
assert.deepEqual(bootstrapSeedNames({ baseUrl: "x", account: "a", seedName: "only" }), ["only"]);

// `?bootstrap=<account>/<seed>&bootstrap-url=<origin>` overrides the file.
assert.deepEqual(
  bootstrapSeedFromParams(new URLSearchParams("bootstrap=personal/trunk&bootstrap-url=http://127.0.0.1:9999")),
  { baseUrl: "http://127.0.0.1:9999", account: "personal", seedName: "trunk" },
  "query override (the smoke's fake service)",
);
assert.equal(bootstrapSeedFromParams(new URLSearchParams("bootstrap=personal")), null, "malformed override");

console.log("seed-bootstrap: all assertions passed");
