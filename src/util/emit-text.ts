/**
 * The chat-facing value of a tree emit.
 *
 * grandma-kat trees emit `{ text }` objects (the `.emit(m => ({ text }))`
 * convention) or plain strings. Chat surfaces must show the text, never the
 * wrapper; structured values without a text field keep the JSON fallback so
 * other emits still surface.
 *
 * A value may also carry `buttons`: a flat list of `{ label, value }`. The
 * chat surface renders each label as a tappable control next to the message
 * and, on tap, feeds the button's `value` back as if the user had typed it.
 * Buttons are transport-neutral (Telegram inline keyboards, web buttons);
 * a platform that cannot render them must fall back to showing the message
 * text alone — the value is always a valid reply to the pause it belongs to,
 * so a user can still type it.
 */
export interface EmitButton {
  label: string;
  value: string;
}

export interface EmitValue {
  text: string;
  buttons?: EmitButton[];
  /**
   * Optional channel tag. `"machine"` marks engine narration (the `{ machine }`
   * emit shape); unset means user-facing. Surfaces may style or filter by it —
   * the value always reaches onEmit.
   */
  level?: string;
}

/** A readable one-line summary of a `{ machine }` narration payload. */
function machineLine(machine: unknown): string {
  if (machine == null || typeof machine !== "object" || Array.isArray(machine)) return "";
  const m = machine as { tree?: unknown; doing?: unknown; at?: unknown; detail?: unknown; priority?: unknown };
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const detail = str(m.detail);
  if (detail) return detail;
  const head = [str(m.tree), str(m.doing)].filter(Boolean).join(" ");
  const at = str(m.at);
  const priority = str(m.priority);
  let line = head;
  if (at) line += ` at ${at}`;
  if (priority) line += ` — ${priority}`;
  return line.trim();
}

/** Buttons a chat surface can render: string label + string value, trimmed. */
function parseButtons(raw: unknown): EmitButton[] {
  if (!Array.isArray(raw)) return [];
  const out: EmitButton[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
    const { label, value } = item as { label?: unknown; value?: unknown };
    if (typeof label !== "string" || typeof value !== "string") continue;
    const l = label.trim();
    const v = value.trim();
    if (!l || !v) continue;
    out.push({ label: l, value: v });
  }
  return out;
}

/** Split an emitted value into the message text, buttons, and channel level. */
export function emitValue(value: unknown): EmitValue {
  if (value == null) return { text: "" };
  if (typeof value === "string") return { text: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as { text?: unknown; buttons?: unknown; level?: unknown; machine?: unknown };
    const level = typeof v.level === "string" && v.level.trim() ? v.level.trim() : undefined;
    if (typeof v.text === "string") {
      const buttons = parseButtons(v.buttons);
      const out: EmitValue = { text: v.text };
      if (buttons.length) out.buttons = buttons;
      if (level) out.level = level;
      return out;
    }
    // Engine narration ({ machine }): show a readable line, tagged "machine".
    // It still reaches onEmit — a surface may style or filter it, not lose it.
    if (v.machine != null) {
      return { text: machineLine(v.machine), level: level ?? "machine" };
    }
    // no text field: not the { text } convention — fall through to JSON so
    // the value still surfaces.
  }
  return { text: JSON.stringify(value) };
}

/** The chat-facing text alone; buttons are ignored. */
export function emitText(value: unknown): string {
  return emitValue(value).text;
}
