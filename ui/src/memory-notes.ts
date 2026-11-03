/** Memory-update rows for the chat.
 *
 *  The engine logs every slot write as a `record` event with `op` "memory"
 *  (a declaration) or "memoryUpdate" (an existing slot changed). Only updates
 *  belong in the conversation: declarations are replayed on every restored
 *  turn, so surfacing them would bury the replies in noise.
 *
 *  A note is anchored to the emit index it happened before. The turn's event
 *  tail is capped (MAX_TURN_EVENTS), so the first emit still present may not
 *  be the turn's first bubble; the offset below re-bases the count onto the
 *  turn's full emits array.
 */
import type { SanitizedEvent, Turn } from "./types";

export interface MemoryNote {
  /** Stable identity for bubble reuse (the log row when there is one). */
  key: string;
  child: string;
  /** The declaring branch path plus the slot name. */
  path: string;
  scopeId: number | null;
  value: unknown;
  /** Run-log row, used to load the untruncated value on expand. */
  seq?: number;
}

const noteCache = new WeakMap<SanitizedEvent, MemoryNote | null>();

/** The memory update one event records, or null for every other event. */
export function memoryNote(ev: SanitizedEvent): MemoryNote | null {
  if (noteCache.has(ev)) return noteCache.get(ev) ?? null;
  const note = readMemoryNote(ev);
  noteCache.set(ev, note);
  return note;
}

function readMemoryNote(ev: SanitizedEvent): MemoryNote | null {
  if (ev.kind !== "record") return null;
  const content = ev.content;
  if (!content || content.op !== "memoryUpdate") return null;
  if (!("value" in content)) return null;
  const child = typeof content.child === "string" ? content.child : "";
  if (!child) return null;
  const branch = ev.branch_path ?? "";
  const path = branch ? `${branch}/${child}` : child;
  const seq = Number.isInteger(ev.seq) ? (ev.seq as number) : undefined;
  return {
    key: seq != null ? `seq:${seq}` : `ev:${ev.ts}:${path}`,
    child,
    path,
    scopeId: ev.scope_id ?? null,
    value: content.value,
    ...(seq != null ? { seq } : {}),
  };
}

export interface AnchoredMemoryNote {
  /** Insert the line before the emit bubble at this index. */
  anchor: number;
  note: MemoryNote;
}

/** Memory updates for one app in a turn, in event order, anchored to its
 *  emit bubbles. */
export function memoryNotesForTurn(turn: Turn, app = "trunk"): AnchoredMemoryNote[] {
  const events = turn.events ?? [];
  let emitEvents = 0;
  for (const ev of events) if (ev.kind === "emit") emitEvents++;
  // Re-base a capped tail onto the turn's full emits list.
  let seen = Math.max(0, (turn.emits?.length ?? 0) - emitEvents);
  const out: AnchoredMemoryNote[] = [];
  for (const ev of events) {
    if (ev.kind === "emit") {
      seen++;
      continue;
    }
    if ((ev.app ?? "trunk") !== app) continue;
    const note = memoryNote(ev);
    if (note) out.push({ anchor: seen, note });
  }
  return out;
}
