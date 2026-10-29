// The mini-tile icon set: a small collection of object glyphs used as a faint
// watermark behind a hidden tile's initials. An app has no way to set its own
// icon yet, so a name picks one deterministically: keywords first (so "email"
// gets an envelope, "knit" gets a knot), then a stable hash across the set so
// every app — including future ones — keeps the same glyph while it exists.

import book from "./assets/app-icons/book.svg";
import chart from "./assets/app-icons/chart.svg";
import chat from "./assets/app-icons/chat.svg";
import envelope from "./assets/app-icons/envelope.svg";
import folder from "./assets/app-icons/folder.svg";
import globe from "./assets/app-icons/globe.svg";
import knot from "./assets/app-icons/knot.svg";
import list from "./assets/app-icons/list.svg";
import microphone from "./assets/app-icons/microphone.svg";
import person from "./assets/app-icons/person.svg";
import phone from "./assets/app-icons/phone.svg";
import settings from "./assets/app-icons/settings.svg";
import sparkles from "./assets/app-icons/sparkles.svg";
import tree from "./assets/app-icons/tree.svg";

/** Keep this order stable: the hash fallback indexes into it. Append new icons
 *  at the end so existing apps don't shuffle between glyphs. */
const ICON_URLS = [
  envelope,
  globe,
  person,
  phone,
  microphone,
  folder,
  chart,
  book,
  list,
  knot,
  tree,
  chat,
  sparkles,
  settings,
];

/** First matching rule wins, so specific words (enrich, transcriber) come
 *  before the general ones they contain (profile, caller). */
const KEYWORD_RULES: [RegExp, number][] = [
  [/enrich|sparkle|magic/, 12],
  [/mail|email|inbox/, 0],
  [/transcri|voice|audio|mic\b/, 4],
  [/call|phone|telnyx/, 3],
  [/browse|browser|web\b|globe/, 1],
  [/contact|profile|person|people|user|caller|customer/, 2],
  [/file|folder|doc|archive/, 5],
  [/insight|chart|analytic|report|stat|metric|dashboard/, 6],
  [/story|book|read|novel/, 7],
  [/list|queue|todo/, 8],
  [/knit|knot|link|connect|yarn/, 9],
  [/trunk|tree|branch/, 10],
  [/chat|message|talk|conversation/, 11],
  [/setting|config|gear|tool|wrench|admin/, 13],
];

function stableHash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** The icon URL for an app name: keyword match first, stable hash otherwise. */
export function appIconUrl(name: string): string {
  const lower = name.toLowerCase();
  for (const [pattern, index] of KEYWORD_RULES) {
    if (pattern.test(lower)) return ICON_URLS[index];
  }
  return ICON_URLS[stableHash(lower) % ICON_URLS.length];
}
