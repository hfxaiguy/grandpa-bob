/**
 * A small, readable pairing history for the Pair dialog.
 *
 * This is deliberately separate from the run log and the peer log. It records
 * the user-facing pairing timeline (transport status, verification phrase,
 * approval, failures) in localStorage, so a failed attempt can still be read
 * after a retry or a page reload. Pairing codes are single-use and expire, but
 * they are redacted before storage anyway; role tokens and service keys are
 * never passed here.
 */
export type PairLogLevel = "info" | "ok" | "warn" | "error";

export interface PairLogEntry {
  /** ISO timestamp of the latest occurrence. */
  at: string;
  level: PairLogLevel;
  /** One-line, human-readable message (redacted). */
  text: string;
  /** Consecutive repeats collapsed into one row. */
  count: number;
}

/** The tiny part of Storage this module needs (easy to fake in tests). */
export interface PairLogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PAIR_LOG_KEY = "bob:pair-log";
export const PAIR_LOG_LIMIT = 250;

const LEVELS: ReadonlySet<string> = new Set(["info", "ok", "warn", "error"]);

/** localStorage itself can throw (sandboxed/opaque origins), not just access. */
function defaultStorage(): PairLogStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Turn a transport message into one safe line: collapse whitespace, hide
 * pairing codes / key values, and cap the length so a giant error cannot make
 * the dialog unusable.
 */
export function redactPairText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\d{4}[- ]?\d{4}\b/g, "••••-••••")
    .replace(/([?&](?:key|token|secret)=)[^&\s]+/gi, "$1…")
    .replace(/(\b(?:role[ _-]?token|token|secret|password|key)\b\s*[:=]\s*)[^\s,;&]+/gi, "$1…")
    .slice(0, 500);
}

function normalizeEntry(raw: unknown): PairLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const text = typeof value.text === "string" ? value.text.trim().slice(0, 500) : "";
  const level =
    typeof value.level === "string" && LEVELS.has(value.level)
      ? (value.level as PairLogLevel)
      : null;
  if (!text || !level) return null;
  const at =
    typeof value.at === "string" && !Number.isNaN(Date.parse(value.at))
      ? value.at
      : new Date().toISOString();
  const count =
    typeof value.count === "number" && Number.isFinite(value.count) && value.count > 0
      ? Math.floor(value.count)
      : 1;
  return { at, level, text, count };
}

/** Parse a persisted log, dropping malformed rows instead of failing. */
export function parsePairLog(raw: string | null): PairLogEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeEntry)
      .filter((entry): entry is PairLogEntry => entry !== null)
      .slice(-PAIR_LOG_LIMIT);
  } catch {
    return [];
  }
}

export function loadPairLog(
  storage: PairLogStorage | undefined = defaultStorage(),
): PairLogEntry[] {
  try {
    return parsePairLog(storage?.getItem(PAIR_LOG_KEY) ?? null);
  } catch {
    return [];
  }
}

export function savePairLog(
  entries: PairLogEntry[],
  storage: PairLogStorage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(PAIR_LOG_KEY, JSON.stringify(entries.slice(-PAIR_LOG_LIMIT)));
  } catch {
    /* private mode: the in-memory list still works for this tab */
  }
}

export function clearPairLog(
  storage: PairLogStorage | undefined = defaultStorage(),
): void {
  try {
    storage?.removeItem(PAIR_LOG_KEY);
  } catch {
    /* nothing persisted */
  }
}

/**
 * Append one event. Identical consecutive events collapse into a count, so a
 * relay poll that repeats "waiting for the other side" every second stays a
 * single readable row.
 */
export function appendPairLog(
  entries: PairLogEntry[],
  level: PairLogLevel,
  text: string,
  now: Date = new Date(),
): PairLogEntry[] {
  const clean = redactPairText(text);
  if (!clean) return entries;
  const at = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
  const last = entries[entries.length - 1];
  if (last && last.level === level && last.text === clean) {
    last.at = at;
    last.count += 1;
    return entries;
  }
  return [...entries, { at, level, text: clean, count: 1 }].slice(-PAIR_LOG_LIMIT);
}

/** Plain-text form for the Copy button (and bug reports). */
export function formatPairLog(entries: PairLogEntry[]): string {
  return entries
    .map((entry) => {
      const date = new Date(entry.at);
      const when = Number.isNaN(date.getTime()) ? entry.at : date.toISOString();
      const repeats = entry.count > 1 ? ` (x${entry.count})` : "";
      return `${when} ${entry.level.toUpperCase()} ${entry.text}${repeats}`;
    })
    .join("\n");
}
