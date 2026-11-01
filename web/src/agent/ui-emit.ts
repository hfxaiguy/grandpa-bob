// src/agent/ui-emit.ts
//
// Host-side emit sugar for workspace UI components.
//
// grandma-kat's Emit already accepts marker arguments (flags) but does not know
// about visual components. The browser host injects the grandma-kat namespace
// into every workspace module (see module-loader.ts), so it can widen Emit
// there without forking the engine:
//
//   import { Emit, flag } from "grandma-kat";
//   import { component } from "bob/ui";
//
//   Emit({ text: "Keith owes 3 calls", who: "Keith", count: 3 }, component("ui.mjs"))
//
// The wrapper merges the marker into the emitted value:
//
//   { text: "Keith owes 3 calls", who: "Keith", count: 3,
//     component: "ui.mjs", props: { who: "Keith", count: 3 } }
//
// `props` defaults to the emitted object without its transport fields (text,
// buttons, level), so the component gets the data and the phone still gets the
// text. `component(path, props)` overrides them explicitly. Paths are
// resolved by the host: `ui.mjs` is relative to the emitting app's folder;
// a path starting with `app/` or `patterns/` is workspace-relative.
//
// This is deliberately a host capability, not a grandma-kat feature: the Node
// channels never run trees, and the sandboxed renderer lives in the web UI.

import { isFlag, isWhen } from "grandma-kat";

const COMPONENT = Symbol.for("grandma-bob/emit-component");

/** The marker `component(path, props?)` returns. */
export interface ComponentMarker {
  readonly [COMPONENT]: true;
  readonly path: string;
  readonly props?: unknown;
}

/** True for a marker produced by `component(...)`. */
export function isComponentMarker(value: unknown): value is ComponentMarker {
  return value != null && typeof value === "object" && (value as { [COMPONENT]?: unknown })[COMPONENT] === true;
}

/**
 * Name the visual component an emit renders in the web chat. `path` is a
 * `.mjs` module beside the emitting app's tree (or a workspace-relative path
 * starting with `app/` / `patterns/`). `props` defaults to the emit's own data.
 */
export function component(path: string, props?: unknown): ComponentMarker {
  if (typeof path !== "string" || !path.trim()) {
    throw new TypeError('component(path) expects a non-empty .mjs path, e.g. component("ui.mjs")');
  }
  const marker: {
    [COMPONENT]: true;
    path: string;
    props?: unknown;
  } = { [COMPONENT]: true, path: path.trim() };
  if (props !== undefined) marker.props = props;
  return Object.freeze(marker);
}

type AnyFn = (...args: unknown[]) => unknown;

/** The transport fields that are not component data. */
function dataProps(value: Record<string, unknown>): Record<string, unknown> {
  const { text: _text, buttons: _buttons, level: _level, component: _component, props: _props, ...rest } = value;
  return rest;
}

/** Merge a component marker into one emitted value. */
function decorate(value: unknown, marker: ComponentMarker): Record<string, unknown> {
  if (typeof value === "string") {
    const out: Record<string, unknown> = { text: value, component: marker.path };
    if (marker.props !== undefined) out.props = marker.props;
    return out;
  }
  if (value == null) {
    const out: Record<string, unknown> = { text: "", component: marker.path };
    if (marker.props !== undefined) out.props = marker.props;
    return out;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj, component: marker.path };
    if (marker.props !== undefined) {
      out.props = marker.props;
    } else if (obj.props !== undefined) {
      // already explicit
    } else {
      const rest = dataProps(obj);
      if (Object.keys(rest).length) out.props = rest;
      else delete out.props;
    }
    return out;
  }
  // arrays/scalars have no data fields — keep the JSON text and the marker.
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  const out: Record<string, unknown> = { text, component: marker.path };
  if (marker.props !== undefined) out.props = marker.props;
  return out;
}

/**
 * Wrap a grandma-kat namespace so Emit understands `component(...)` markers.
 * Everything else (flags, gates, element shape) delegates to the real Emit.
 */
export function withUiEmit<T extends Record<string, unknown>>(gk: T): T {
  const candidate = gk.Emit;
  if (typeof candidate !== "function") return gk;
  const rawEmit: AnyFn = candidate as AnyFn;

  function Emit(...args: unknown[]): unknown {
    const marker = args.find(isComponentMarker);
    if (!marker) return rawEmit.apply(gk, args);
    const rest = args.filter((arg) => arg !== marker);
    // The value is the first non-flag argument; the rest are Emit markers
    // (flags, gates) and must reach the real Emit untouched. `Emit(component(p),
    // flag(s))` — no data — is a valid marker-only emit too.
    const valueIndex = rest.findIndex((arg) => !isFlag(arg) && !isWhen(arg));
    const value = valueIndex >= 0 ? rest[valueIndex] : undefined;
    const extras = rest.filter((_arg, i) => i !== valueIndex);
    // Always emit through a function: it is the only literal form grandma-kat
    // accepts without a flag, and it keeps the marker value lazy.
    const source = typeof value === "function" ? (value as AnyFn) : () => value;
    return rawEmit.call(gk, (view: unknown) => decorate(source(view), marker), ...extras);
  }

  return { ...gk, Emit } as T;
}

/** The virtual `bob/ui` module workspace trees import. */
export const BOB_UI_MODULE: { component: typeof component } = { component };
