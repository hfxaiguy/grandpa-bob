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
 *
 * A value may also carry `component`: a workspace UI module (a sibling
 * `ui.mjs` of the emitting app, or an explicit `app/…` / `patterns/…` path)
 * rendered by the web chat in a sandboxed iframe. `props` is what the
 * component receives. The chat is the only surface that renders it; Telegram
 * and every other channel fall back to `text`, exactly like buttons. Component
 * bubbles without a text field derive a compact props summary for that
 * fallback.
 */
export interface EmitButton {
  label: string;
  value: string;
}

/** A workspace component attached to an emit: the source path + its props. */
export interface EmitComponent {
  /**
   * The component module. Without a leading `app/` or `patterns/` this is
   * relative to the emitting app's folder (`ui.mjs` beside `tree.prod.mjs`);
   * otherwise it is workspace-relative. Must end in `.mjs`.
   */
  src: string;
  /** Values the component renders. */
  props?: unknown;
}

export interface EmitValue {
  text: string;
  buttons?: EmitButton[];
  component?: EmitComponent;
  /**
   * Optional channel tag. `"machine"` marks engine narration (the `{ machine }`
   * emit shape or `Emit(..., flag("machine"))`); unset means user-facing.
   * Surfaces may style or filter by it — the value always reaches onEmit.
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

/**
 * A component attached to an emit. Accepts the sugar the browser host's
 * `component(...)` marker produces (`component: "ui.mjs"` + the emit's own
 * `props`) and the explicit `{ src|path, props }` object form. Malformed
 * values are dropped so a bad emit can never break the bubble.
 */
function parseComponent(raw: unknown, outerProps: unknown): EmitComponent | undefined {
  let src = "";
  let props = outerProps;
  if (typeof raw === "string") {
    src = raw.trim();
  } else if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const c = raw as { src?: unknown; path?: unknown; props?: unknown };
    src = typeof c.src === "string" ? c.src.trim() : typeof c.path === "string" ? c.path.trim() : "";
    if (c.props !== undefined) props = c.props;
  }
  if (!src || !src.endsWith(".mjs")) return undefined;
  const out: EmitComponent = { src };
  if (props !== undefined) out.props = props;
  return out;
}

/**
 * One-line text a non-rendering channel shows when a component emit carries no
 * `text` of its own. A component exists to be seen, so a missing text is a
 * normal shape — the fallback is the props, not the whole envelope.
 */
function componentFallbackText(component: EmitComponent): string {
  try {
    const props = component.props;
    if (props == null) return "";
    const text = typeof props === "string" ? props : JSON.stringify(props);
    return text.length > 400 ? `${text.slice(0, 399)}…` : text;
  } catch {
    return "";
  }
}

/** Split an emitted value into the message text, buttons, component, and level. */
export function emitValue(value: unknown): EmitValue {
  if (value == null) return { text: "" };
  if (typeof value === "string") return { text: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as {
      text?: unknown;
      buttons?: unknown;
      level?: unknown;
      machine?: unknown;
      component?: unknown;
      props?: unknown;
    };
    const level = typeof v.level === "string" && v.level.trim() ? v.level.trim() : undefined;
    const component = parseComponent(v.component, v.props);
    if (typeof v.text === "string") {
      const buttons = parseButtons(v.buttons);
      const out: EmitValue = { text: v.text };
      if (buttons.length) out.buttons = buttons;
      if (component) out.component = component;
      if (level) out.level = level;
      return out;
    }
    // Engine narration ({ machine }): show a readable line, tagged "machine".
    // It still reaches onEmit — a surface may style or filter it, not lose it.
    if (v.machine != null) {
      return { text: machineLine(v.machine), level: level ?? "machine" };
    }
    // A visual component with no text of its own: the props are the fallback
    // for channels that cannot render it. Never dump the whole envelope.
    if (component) {
      const out: EmitValue = { text: componentFallbackText(component), component };
      if (level) out.level = level;
      return out;
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
