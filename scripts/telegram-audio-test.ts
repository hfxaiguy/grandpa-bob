/**
 * Telegram audio routing: every spoken message kind is recognized so the bot
 * is fully talkable-to.
 *
 *   - a voice note        -> `voice`
 *   - a forwarded voice / uploaded recording -> `audio`
 *   - a round video message -> `video_note`
 *
 * Non-audio messages (text, photo, document) yield null, so the audio handler
 * never fires for them. Pure, no network. Run: `npm run test:telegram-audio`.
 */
import assert from "node:assert/strict";
import { telegramAudioOf } from "../src/bot.js";

/** Call the classifier with an arbitrary message shape (real updates carry many fields). */
const of = (message: unknown) => telegramAudioOf(message as Parameters<typeof telegramAudioOf>[0]);

// ── 1. each spoken kind is recognized, with its file_id ──
assert.deepEqual(of({ voice: { file_id: "v1" } }), { kind: "voice", fileId: "v1" });
assert.deepEqual(of({ audio: { file_id: "a1" } }), { kind: "audio", fileId: "a1" });
assert.deepEqual(of({ video_note: { file_id: "r1" } }), { kind: "video_note", fileId: "r1" });

// ── 2. voice wins if a message somehow carries several (Telegram won't) ──
assert.deepEqual(
  of({ voice: { file_id: "v1" }, audio: { file_id: "a1" } }),
  { kind: "voice", fileId: "v1" },
);

// ── 3. non-audio messages are not audio ──
assert.equal(of({}), null, "an empty message is not audio");
assert.equal(of({ text: "hi" }), null, "text is not audio");
assert.equal(of({ photo: [{ file_id: "p1" }] }), null, "a photo is not audio");
assert.equal(of({ document: { file_id: "d1" } }), null, "a document is not audio");

// ── 4. an audio field with no file_id is not usable ──
assert.equal(of({ voice: {} }), null, "a voice with no file_id is skipped");
assert.equal(of({ audio: {} }), null, "an audio with no file_id is skipped");
assert.equal(of({ video_note: {} }), null, "a video note with no file_id is skipped");

console.log("telegram-audio-test: voice / audio / video note routing OK");
