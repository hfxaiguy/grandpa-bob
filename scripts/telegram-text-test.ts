/**
 * Telegram reply formatting: HTML escaping + phone linkification.
 *
 * Replies are sent with parse_mode "HTML" so caller-list phone lines can be
 * tap-to-dial tel: links. Everything else must survive literally: escape
 * &, < and >, and only link numbers that carry a country code (+...).
 *
 * Rich messages (sendRichMessage) take the same HTML but must spell line
 * breaks as <br>: their HTML collapses raw newlines, while classic
 * parse_mode "HTML" keeps them.
 *
 * Run: npm run test:telegram-text
 */
import assert from "node:assert/strict";
import { escapeHtml, linkPhones, telegramHtml, telegramRichHtml } from "../src/util/telegram-text.js";

// ── 1. escaping: HTML metacharacters stay literal ──
assert.equal(escapeHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
assert.equal(escapeHtml("no markup"), "no markup");

// ── 2. link: a formatted E.164 number becomes tap-to-dial ──
assert.equal(
  linkPhones("Phone: +1 616-785-6125 (office)"),
  'Phone: <a href="tel:+16167856125">+1 616-785-6125</a> (office)',
);
assert.equal(
  linkPhones("Also: +1-902-555-0199"),
  'Also: <a href="tel:+19025550199">+1-902-555-0199</a>',
);

// ── 3. labels and prose around the number stay outside the link ──
assert.equal(
  linkPhones("call +1 (555) 123-4567 now"),
  'call <a href="tel:+15551234567">+1 (555) 123-4567</a> now',
);
assert.equal(
  linkPhones("+1 417-866-2322 ext. 2071"),
  '<a href="tel:+14178662322">+1 417-866-2322</a> ext. 2071',
  "an extension is not part of the dialable number",
);

// ── 4. no country code: nothing to dial, leave it alone ──
assert.equal(linkPhones("Phone: (555) 555-5555"), "Phone: (555) 555-5555");
assert.equal(linkPhones("2026-09-23"), "2026-09-23");

// ── 5. the combined transform: one line per phone, all linked ──
assert.equal(
  telegramHtml("1/2 \u2014 Jane Doe\nPhone: +1 616-785-6125\nPhone: +1 616-866-0815 (office)"),
  '1/2 \u2014 Jane Doe\nPhone: <a href="tel:+16167856125">+1 616-785-6125</a>\n' +
    'Phone: <a href="tel:+16168660815">+1 616-866-0815</a> (office)',
);

// ── 6. order: escape first, then link (the + is not an HTML character) ──
assert.equal(
  telegramHtml("<b> +1 616-785-6125"),
  '&lt;b&gt; <a href="tel:+16167856125">+1 616-785-6125</a>',
);

// ── 7. rich HTML: line breaks stay explicit, blank lines stay blank ──
assert.equal(
  telegramRichHtml("one\ntwo\n\nthree"),
  "one<br>two<br><br>three",
  "every newline becomes a <br>, so the line structure survives",
);
assert.equal(
  telegramRichHtml("a < b\nc & d"),
  "a &lt; b<br>c &amp; d",
  "escaping still applies before the <br> substitution",
);
assert.equal(
  telegramRichHtml("Phone: +1 616-785-6125\nalt: +1-902-555-0199"),
  'Phone: <a href="tel:+16167856125">+1 616-785-6125</a><br>' +
    'alt: <a href="tel:+19025550199">+1-902-555-0199</a>',
  "phone links and line breaks combine",
);
assert.equal(
  telegramHtml("one\ntwo"),
  "one\ntwo",
  "classic HTML has no <br>; the raw newline stays a line break",
);

console.log("telegram-text-test: escaping and tel: links OK");
