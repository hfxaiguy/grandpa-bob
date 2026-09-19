/**
 * The chat-facing text of a value emitted by a tree.
 *
 * grandma-kat trees emit `{ text }` objects (the `.emit(m => ({ text }))`
 * convention) or plain strings. Chat surfaces must show the text, never the
 * wrapper; structured values without a text field keep the JSON fallback so
 * other emits still surface.
 */
export function emitText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(value);
}
