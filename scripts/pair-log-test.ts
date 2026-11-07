// Offline test of the Pair dialog's readable history (`web/src/pair-log.ts`).
//
// Run: `npm run test:pair-log`.
import assert from "node:assert/strict";

import {
  PAIR_LOG_LIMIT,
  appendPairLog,
  clearPairLog,
  formatPairLog,
  loadPairLog,
  parsePairLog,
  redactPairText,
  savePairLog,
  type PairLogEntry,
  type PairLogStorage,
} from "../web/src/pair-log";

class MemoryStorage implements PairLogStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

try {
  // Codes and key material never land in a log that can be copied/shared.
  assert.equal(redactPairText("code 1234-5678 created"), "code ••••-•••• created");
  assert.equal(redactPairText("relay key=supersecret"), "relay key=…");
  assert.equal(redactPairText("https://relay.example/join?token=abc&x=1"), "https://relay.example/join?token=…&x=1");
  assert.equal(redactPairText("  line one\n line   two  "), "line one line two");
  assert.equal(redactPairText("x".repeat(600)).length, 500, "a giant message is capped");
  console.log("ok  redaction and one-line normalization");

  let entries: PairLogEntry[] = [];
  const first = new Date("2026-11-07T12:00:00Z");
  entries = appendPairLog(entries, "info", "joining the relay…", first);
  entries = appendPairLog(entries, "info", "joining the relay…", new Date("2026-11-07T12:00:01Z"));
  assert.equal(entries.length, 1, "a repeated poll status stays one readable row");
  assert.equal(entries[0].count, 2, "repeats are counted");
  assert.equal(entries[0].at, "2026-11-07T12:00:01.000Z", "the row keeps the latest time");
  entries = appendPairLog(entries, "error", "pairing failed: timeout");
  assert.equal(entries.length, 2, "a different message becomes a new row");
  assert.equal(entries[1].level, "error");
  console.log("ok  repeats collapse and levels are preserved");

  const storage = new MemoryStorage();
  savePairLog(entries, storage);
  assert.deepEqual(loadPairLog(storage), entries, "the log round-trips through storage");
  assert.match(formatPairLog(entries), /ERROR pairing failed: timeout/);
  assert.match(formatPairLog(entries), /\(x2\)/, "the text form shows repeat counts");
  clearPairLog(storage);
  assert.deepEqual(loadPairLog(storage), [], "clear removes the persisted log");
  console.log("ok  persistence, text form and clear");

  // A corrupted/short entry must not blank the whole history.
  const parsed = parsePairLog(
    JSON.stringify([
      { at: "not a date", level: "info", text: "kept with a fresh timestamp" },
      { level: "info", text: "" },
      { at: "2026-11-07T12:00:00Z", level: "nope", text: "dropped" },
      "nonsense",
    ]),
  );
  assert.equal(parsed.length, 1, "only valid rows survive");
  assert.equal(parsed[0].count, 1, "a missing count defaults to one");
  assert.deepEqual(parsePairLog("{bad json"), [], "bad JSON returns an empty list");
  console.log("ok  malformed persisted rows are tolerated");

  let capped: PairLogEntry[] = [];
  for (let i = 0; i < PAIR_LOG_LIMIT + 20; i++) {
    capped = appendPairLog(capped, "info", `event ${i}`, new Date(2026, 10, 7, 12, 0, i));
  }
  assert.equal(capped.length, PAIR_LOG_LIMIT, "the history is bounded");
  assert.equal(capped[capped.length - 1].text, `event ${PAIR_LOG_LIMIT + 19}`, "the newest row is kept");

  console.log("pair log: redaction, dedupe, persistence and bounds OK");
} catch (err) {
  console.error(err);
  process.exit(1);
}
