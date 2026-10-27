/** Collapsible JSON tree for the tiled UI.
 *
 *  Every JSON-ish surface (memory inspector, run-log payloads, ref and
 *  provenance values) renders through this component, so a payload looks the
 *  same everywhere: a collapsible tree with syntax colors, a summary on
 *  collapsed nodes, and `ref://…` handles that stay clickable inside string
 *  values (the markdown renderer would otherwise mangle raw JSON).
 *
 *  `text` is for payloads that arrive as strings (run-log rows, the event
 *  detail): it is parsed once and shown verbatim in a <pre> when the text is
 *  not JSON (e.g. a truncated row or a plain string value).
 */
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { withRefs } from "./markdown";

export interface JsonViewProps {
  /** A value to render. Ignored when `text` is set. */
  value?: unknown;
  /** A JSON string to render; non-JSON text is shown verbatim. */
  text?: string;
  /** Collections at this depth or deeper start collapsed. Default 2, so the
   *  root and its direct children are open. */
  startDepth?: number;
  /** Render one `ref://…` handle inside a string; omit to leave it plain. */
  renderRef?: (token: string) => JSX.Element;
}

/** Strings longer than this are clipped until the user asks for the rest. */
const STRING_LIMIT = 400;

type Parsed = { json: true; value: unknown } | { json: false; text: string };

export function JsonView(props: JsonViewProps): JSX.Element {
  const parsed = createMemo<Parsed>(() => {
    if (props.text === undefined) return { json: true, value: props.value };
    try {
      return { json: true, value: JSON.parse(props.text) as unknown };
    } catch {
      return { json: false, text: props.text };
    }
  });
  const value = () => (parsed().json ? (parsed() as { value: unknown }).value : undefined);
  const raw = () => (parsed().json ? "" : (parsed() as { text: string }).text);
  return (
    <Show
      when={parsed().json}
      fallback={
        <pre class="jv-raw">{raw()}</pre>
      }
    >
      <JsonNode
        value={value()}
        depth={0}
        startDepth={props.startDepth ?? 2}
        renderRef={props.renderRef}
      />
    </Show>
  );
}

interface JsonNodeProps {
  value: unknown;
  depth: number;
  startDepth: number;
  renderRef?: (token: string) => JSX.Element;
  /** Append a trailing comma (the value is not its collection's last entry). */
  comma?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One value: a collapsible collection or a leaf. */
function JsonNode(props: JsonNodeProps): JSX.Element {
  const isArray = () => Array.isArray(props.value);
  const isTree = () => isArray() || isRecord(props.value);
  const entries = createMemo<[string, unknown][]>(() => {
    if (isArray()) return (props.value as unknown[]).map((v, i) => [String(i), v]);
    if (isRecord(props.value)) return Object.entries(props.value);
    return [];
  });
  const [open, setOpen] = createSignal(props.depth < props.startDepth);
  const openBrace = () => (isArray() ? "[" : "{");
  const closeBrace = () => (isArray() ? "]" : "}");
  const countLabel = () => {
    const n = entries().length;
    if (isArray()) return `${n} ${n === 1 ? "item" : "items"}`;
    return `${n} ${n === 1 ? "key" : "keys"}`;
  };
  return (
    <Show when={isTree()} fallback={<JsonPrimitive value={props.value} renderRef={props.renderRef} comma={props.comma} />}>
      <Show
        when={entries().length}
        fallback={
          <span class="jv-brace">
            {openBrace()}
            {closeBrace()}
            {props.comma ? "," : ""}
          </span>
        }
      >
        <span class="jv-node">
          <button
            type="button"
            class="jv-toggle"
            aria-expanded={open()}
            title={open() ? "collapse" : "expand"}
            onClick={(ev) => {
              ev.preventDefault();
              // A JSON caret can sit inside a clickable card (the provenance
              // writer); expanding it must not also collapse that card.
              ev.stopPropagation();
              setOpen(!open());
            }}
          >
            <span class="jv-caret">{open() ? "▾" : "▸"}</span>
            <span class="jv-brace">{openBrace()}</span>
            <Show when={!open()}>
              <span class="jv-summary">{countLabel()}</span>
              <span class="jv-brace">
                {closeBrace()}
                {props.comma ? "," : ""}
              </span>
            </Show>
          </button>
          <Show when={open()}>
            <span class="jv-rows">
              <For each={entries()}>
                {(entry, i) => (
                  <span class="jv-row">
                    <span class="jv-key" classList={{ "jv-index": isArray() }}>
                      {isArray() ? entry[0] : JSON.stringify(entry[0])}
                    </span>
                    <span class="jv-punc">: </span>
                    <JsonNode
                      value={entry[1]}
                      depth={props.depth + 1}
                      startDepth={props.startDepth}
                      renderRef={props.renderRef}
                      comma={i() < entries().length - 1}
                    />
                  </span>
                )}
              </For>
            </span>
            <span class="jv-punc jv-close">
              {closeBrace()}
              {props.comma ? "," : ""}
            </span>
          </Show>
        </span>
      </Show>
    </Show>
  );
}

/** A non-collection value, colored by JSON type. */
function JsonPrimitive(props: {
  value: unknown;
  renderRef?: (token: string) => JSX.Element;
  comma?: boolean;
}): JSX.Element {
  return (
    <>
      <Switch fallback={<span class="jv-null">{String(props.value)}</span>}>
        <Match when={typeof props.value === "string"}>
          <JsonString value={props.value as string} renderRef={props.renderRef} />
        </Match>
        <Match when={typeof props.value === "number"}>
          <span class="jv-num">{String(props.value)}</span>
        </Match>
        <Match when={typeof props.value === "boolean"}>
          <span class="jv-bool">{String(props.value)}</span>
        </Match>
        <Match when={props.value === null || props.value === undefined}>
          <span class="jv-null">{props.value === null ? "null" : "undefined"}</span>
        </Match>
      </Switch>
      <Show when={props.comma}>
        <span class="jv-punc">,</span>
      </Show>
    </>
  );
}

/** A JSON string, clipped at STRING_LIMIT with a "show all" affordance, and
 *  with any `ref://…` handles left clickable. */
function JsonString(props: { value: string; renderRef?: (token: string) => JSX.Element }): JSX.Element {
  const [all, setAll] = createSignal(false);
  const clipped = () => !all() && props.value.length > STRING_LIMIT;
  const shown = () => (clipped() ? props.value.slice(0, STRING_LIMIT) : props.value);
  // Escape the way JSON would (quotes, backslashes, newlines), then hand the
  // inner text to the ref splitter so handles stay inspectable.
  const inner = () => JSON.stringify(shown()).slice(1, -1);
  return (
    <>
      <span class="jv-str">"{withRefs(inner(), props.renderRef)}"</span>
      <Show when={clipped()}>
        <button
          type="button"
          class="jv-more"
          title={`show all ${props.value.length} characters`}
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setAll(true);
          }}
        >
          … {props.value.length} chars
        </button>
      </Show>
    </>
  );
}
