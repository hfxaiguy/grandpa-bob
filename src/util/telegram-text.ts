// Telegram-facing text for replies sent with parse_mode "HTML" (rich messages
// take the same HTML). The bot replies with HTML so it can emit <a> entities:
// phone numbers as tap-to-dial tel: links, email addresses as mailto: links.
// Everything else in a message must stay literal: escape the three characters
// HTML cares about, then wrap every number and address.

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ENTITIES[c]);
}

// Two phone shapes, tried in this order:
//
// - national US/CA: an optional +1, an area code (parenthesized, or followed
//   by a separator), then 3-3-4 groups — "(800) 950-3839", "800.950.3839",
//   "+1 800-950-3839".
// - international: a leading +, a country code, and the usual separators —
//   "+55 11 98765-4321".
//
// Groups must be separated: a bare digit run is never phone-shaped, so dates
// (2026-09-23) and long ids stay literal. A leading + is what makes a number
// internationally dialable, so the href keeps it; a national number dials as
// its own digits.
const PHONE_RE =
  /(?<![\d.])(?:(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}|\+\d[\d\s().-]{6,}\d)(?![\d])/g;

/** Wrap every phone number in the text as a tel: link (does not escape). */
export function linkPhones(text: string): string {
  return text.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, "");
    return `<a href="tel:${match.startsWith("+") ? "+" + digits : digits}">${match}</a>`;
  });
}

// An address in prose. The last domain label is at least two letters, so a
// trailing sentence dot ("mail bob@x.com.") stays outside the link. A leading
// /, : or @ means the address is part of a URL or a mailto: URI — leave it.
const EMAIL_RE = /(?<![/:@])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Wrap every email address as a mailto: link (does not escape). */
export function linkEmails(text: string): string {
  return text.replace(EMAIL_RE, (match) => `<a href="mailto:${match}">${match}</a>`);
}

/** Escape for parse_mode HTML, then link every phone number and address. */
export function telegramHtml(text: string): string {
  return linkEmails(linkPhones(escapeHtml(text)));
}

/**
 * Rich-message HTML: telegramHtml, but line breaks become explicit <br>.
 *
 * Rich messages (sendRichMessage) collapse raw newlines into spaces like
 * HTML whitespace, so a multi-line reply would arrive as one run-on line.
 * Classic parse_mode "HTML" does NOT support <br>, so it keeps this
 * function's input (telegramHtml) and the raw \n stays a line break.
 */
export function telegramRichHtml(text: string): string {
  return telegramHtml(text).replace(/\n/g, "<br>");
}
