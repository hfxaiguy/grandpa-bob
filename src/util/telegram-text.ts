// Telegram-facing text for replies sent with parse_mode "HTML".
//
// The bot replies with HTML parse mode so it can emit <a> entities (phone
// numbers as tap-to-dial tel: links). Everything else in a message must stay
// literal: escape the three characters HTML cares about, then wrap every
// E.164 number. Numbers without a country code (no leading +) are left alone
// — there is no dialable form for them.

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ENTITIES[c]);
}

// A leading +, a country code, and at least seven more digits with the usual
// separators (spaces, dots, dashes, parens).
const PHONE_RE = /\+\d[\d\s().-]{6,}\d/g;

/** Wrap every E.164 number in the text as a tel: link (does not escape). */
export function linkPhones(text: string): string {
  return text.replace(PHONE_RE, (match) => {
    const e164 = "+" + match.replace(/\D/g, "");
    return `<a href="tel:${e164}">${match}</a>`;
  });
}

/** Escape for parse_mode HTML, then make every phone number tap-to-dial. */
export function telegramHtml(text: string): string {
  return linkPhones(escapeHtml(text));
}
