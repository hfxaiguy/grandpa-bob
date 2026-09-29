/**
 * Callback-data indirection for emitted message buttons.
 *
 * Telegram caps callback_data at 64 bytes, but a button's value is arbitrary
 * reply text. So each button is registered here under a short random id, the
 * keyboard carries only "btn:<id>", and a tap resolves the id back to the
 * value. Ids are scoped to the conversation that registered them, so a
 * stale keyboard in one chat can never inject input into another chat's
 * paused tree.
 *
 * Entries expire (a paused conversation does not wait forever) and the map
 * is capped, dropping the oldest ids first.
 */
import { randomBytes } from "node:crypto";

interface Entry {
  key: string;
  value: string;
  expires: number;
}

/** A day is far longer than any realistic pause; the ttl just bounds memory. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 500;

export class ButtonStore {
  private entries = new Map<string, Entry>();

  constructor(
    private ttlMs = DEFAULT_TTL_MS,
    private max = DEFAULT_MAX,
  ) {}

  /** Register `value` for conversation `key`; returns the id for callback_data. */
  register(key: string, value: string): string {
    this.sweep();
    const id = randomBytes(6).toString("base64url");
    this.entries.set(id, { key, value, expires: Date.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return id;
  }

  /** The value behind `id` for `key`; undefined when unknown, expired, or another key's. */
  resolve(key: string, id: string): string | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.entries.delete(id);
      return undefined;
    }
    if (e.key !== key) return undefined;
    return e.value;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (e.expires <= now) this.entries.delete(id);
    }
  }
}
