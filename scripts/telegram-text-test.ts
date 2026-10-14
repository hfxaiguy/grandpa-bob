/**
 * Telegram reply formatting: HTML escaping + email and phone linkification.
 *
 * Replies are sent as HTML so caller-list phone lines can be tap-to-dial
 * tel: links and email addresses (contacts, the email app) can be mailto:
 * links. Everything else must survive literally: escape &, < and >, then wrap
 * every number and address.
 *
 * Numbers link in two shapes — an internationally dialable E.164 number
 * (+...) and a national US/CA-style number whose groups are separated
 * ("(800) 950-3839"). A bare digit run is left alone: no separators means no
 * way to tell a phone number from a date or an id.
 *
 * Rich messages (sendRichMessage) take the same HTML but must spell line
 * breaks as <br>: their HTML collapses raw newlines, while classic
 * parse_mode "HTML" keeps them.
 *
 * Run: npm run test:telegram-text
 */
import assert from "node:assert/strict";
import {
  escapeHtml,
  linkEmails,
  linkPhones,
  telegramHtml,
  telegramRichHtml,
} from "../src/util/telegram-text.js";

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
assert.equal(
  linkPhones("Sao Paulo: +55 11 98765-4321"),
  'Sao Paulo: <a href="tel:+5511987654321">+55 11 98765-4321</a>',
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

// ── 4. a national number links when its groups are separated ──
assert.equal(
  linkPhones("Phone: (555) 555-5555"),
  'Phone: <a href="tel:5555555555">(555) 555-5555</a>',
  "no country code: dialed as written, without a +",
);
assert.equal(
  linkPhones("Also: 800.950.3839"),
  'Also: <a href="tel:8009503839">800.950.3839</a>',
);
assert.equal(
  linkPhones("Or: 1-800-950-3839"),
  'Or: <a href="tel:18009503839">1-800-950-3839</a>',
);

// ── 5. bare digit runs are not numbers ──
assert.equal(linkPhones("2026-09-23"), "2026-09-23", "a date is not a phone number");
assert.equal(
  linkPhones("order 1234567890"),
  "order 1234567890",
  "no separators, no dialable shape",
);

// ── 6. an email address becomes a mailto: link ──
assert.equal(
  linkEmails("write jane.doe@example.com"),
  'write <a href="mailto:jane.doe@example.com">jane.doe@example.com</a>',
);
assert.equal(
  telegramHtml("Email: bob+notes@mail.example.co.uk."),
  'Email: <a href="mailto:bob+notes@mail.example.co.uk">bob+notes@mail.example.co.uk</a>.',
  "a trailing sentence dot stays outside the link",
);
assert.equal(linkEmails("not an address: jane@example"), "not an address: jane@example");

// ── 7. order: escape first, then link numbers, then addresses ──
assert.equal(
  telegramHtml("<b> +1 616-785-6125"),
  '&lt;b&gt; <a href="tel:+16167856125">+1 616-785-6125</a>',
);
assert.equal(
  telegramHtml("<jane@example.com> or +1 616-785-6125"),
  '&lt;<a href="mailto:jane@example.com">jane@example.com</a>&gt; or ' +
    '<a href="tel:+16167856125">+1 616-785-6125</a>',
);
assert.equal(
  telegramHtml("1/2 \u2014 Jane Doe\nPhone: +1 616-785-6125\nPhone: +1 616-866-0815 (office)"),
  '1/2 \u2014 Jane Doe\nPhone: <a href="tel:+16167856125">+1 616-785-6125</a>\n' +
    'Phone: <a href="tel:+16168660815">+1 616-866-0815</a> (office)',
);

// ── 8. rich HTML: line breaks stay explicit, links still apply ──
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
  telegramRichHtml("email bob@example.com\ncall (800) 950-3839"),
  'email <a href="mailto:bob@example.com">bob@example.com</a><br>' +
    'call <a href="tel:8009503839">(800) 950-3839</a>',
  "email links and line breaks combine",
);
assert.equal(
  telegramHtml("one\ntwo"),
  "one\ntwo",
  "classic HTML has no <br>; the raw newline stays a line break",
);

console.log("telegram-text-test: escaping, tel: and mailto: links OK");
