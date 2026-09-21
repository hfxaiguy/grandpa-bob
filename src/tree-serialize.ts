// src/tree-serialize.ts
//
// Serializes a grandma-kat Tree definition (plain data returned by the
// builder chain — see grandma-kat/src/tree.mjs makeDef) into JSON for the
// web UI's tree-structure side panel. Functions (gates, prompts, checks)
// can't cross the wire, so they're reduced to a short source snippet.
//
// Node identity: every serialized node carries `path` — the "/"-joined
// chain of tree names plus child names, matching the runtime log's
// `branch_path` + `content.child`, so the UI can highlight live progress.

export interface SerializedNode {
  kind: string;
  name: string | null;
  path: string;
  gate: string | null;
  [key: string]: unknown;
}

export interface SerializedTree {
  kind: "tree";
  name: string | null;
  path: string;
  models: { when: string | null; value: string }[];
  tools: { when: string | null; value: string[] }[];
  needs: string[];
  children: SerializedNode[];
}

const SNIPPET_LEN = 160;

/** One-line, length-capped source snippet of a function (or null). */
export function fnSnippet(fn: unknown): string | null {
  if (typeof fn !== "function") return null;
  let src: string;
  try {
    src = Function.prototype.toString.call(fn);
  } catch {
    return null;
  }
  src = src.replace(/\s+/g, " ").trim();
  return src.length > SNIPPET_LEN ? src.slice(0, SNIPPET_LEN) + "\u2026" : src;
}

/** Human-readable text for a when() gate condition, or null if ungated. */
function gateText(gate: unknown): string | null {
  const src = fnSnippet(gate);
  return src ? `when ${src}` : null;
}

/** Static prompt text when the def carries data (not a function). */
function promptValue(prompt: unknown): { text?: string; messages?: { role: string; content: string }[]; fn?: string | null } {
  if (typeof prompt === "string") return { text: prompt };
  if (Array.isArray(prompt)) {
    return {
      messages: prompt.map((msg: any) => ({
        role: String(msg?.role ?? "?"),
        content: typeof msg?.content === "string" ? msg.content.slice(0, 500) : JSON.stringify(msg?.content ?? null)?.slice(0, 500) ?? "",
      })),
    };
  }
  return { fn: fnSnippet(prompt) };
}

function maxText(max: { count?: number } | null | undefined): string | null {
  if (!max || typeof max.count !== "number") return null;
  return `max ${max.count}`;
}

function serializeChild(child: any, parentPath: string, fallbackName: string | null = null): SerializedNode {
  const name: string | null = child?.name ?? fallbackName ?? null;
  // Children without a name (emit/check/until/return, anonymous prompts)
  // keep the parent's path — the runtime logs them under content.child or
  // the enclosing tree's branch_path. Unnamed branch/map subtrees get the
  // runtime's auto name via fallbackName so panel paths match branch_path.
  const path = name ? (parentPath ? `${parentPath}/${name}` : name) : parentPath;
  const base: SerializedNode = { kind: String(child?.kind ?? "?"), name, path, gate: gateText(child?.gate) };

  switch (child?.kind) {
    case "branch":
      // The branch child and its inner tree share a name, so seed the inner
      // tree with the *parent* path to avoid "x/y/y" doubling.
      return { ...base, tree: serializeTree(child.tree, parentPath, name) } as SerializedNode;
    case "prompt": {
      const v = promptValue(child.prompt);
      const node: SerializedNode = { ...base, ...v };
      if (child.options?.tools?.length) node.tools = child.options.tools;
      return node;
    }
    case "call": {
      const node: SerializedNode = { ...base, tool: String(child.tool ?? "?") };
      const args = fnSnippet(child.argsFn);
      if (args) node.argsFn = args;
      if (child.options?.tools?.length) node.tools = child.options.tools;
      return node;
    }
    case "check": {
      const f = child.flow ?? {};
      return {
        ...base,
        check: fnSnippet(child.check),
        flow: f.type === "goto"
          ? `goto ${f.target}${f.max?.count != null ? ` (${maxText(f.max)})` : ""}`
          : `goback ${f.n ?? 1}${f.max?.count != null ? ` (${maxText(f.max)})` : ""}`,
      };
    }
    case "until": {
      const jump = child.jumpType === "goto"
        ? `goto ${child.jumpTarget}`
        : child.jumpType === "goback"
          ? `goback ${child.jumpTarget}`
          : "loop to top";
      const max = maxText(child.max);
      return { ...base, check: fnSnippet(child.check), loop: max ? `${jump} ${max}` : jump };
    }
    case "map":
      // An unnamed map subtree takes the collection name at runtime.
      return { ...base, tree: serializeTree(child.tree, parentPath, name) } as SerializedNode;
    case "memory":
    case "memoryUpdate":
      return { ...base, fn: fnSnippet(child.fn) };
    case "human":
      return { ...base, contextFn: fnSnippet(child.contextFn) };
    case "emit":
    case "return": {
      const fn = fnSnippet(child.fn);
      return fn ? { ...base, fn } : base;
    }
    default:
      return base;
  }
}

/**
 * Serialize a Tree definition (or builder — it unwraps `.def`) to JSON.
 * `basePath` seeds node paths; top-level calls should leave it empty so
 * the root tree's name becomes the path root (matching branch_path).
 */
export function serializeTree(tree: any, basePath = "", fallbackName: string | null = null): SerializedTree {
  const def = tree?.def ?? tree;
  if (!def || def.kind !== "tree") throw new TypeError("serializeTree: expected a Tree definition");
  const name: string | null = def.name ?? fallbackName ?? null;
  const path = name ? (basePath ? `${basePath}/${name}` : name) : basePath;
  return {
    kind: "tree",
    name,
    path,
    models: (def.models ?? []).map((r: any) => ({ when: gateText(r.cond), value: String(r.value) })),
    tools: (def.tools ?? []).map((r: any) => ({ when: gateText(r.cond), value: [...(r.value ?? [])] })),
    needs: [...(def.needs ?? [])],
    children: (def.children ?? []).map((c: any, idx: number) => {
      // Same rule as knit()'s autoname: an unnamed branch subtree takes
      // `${parentName}#${k}` (k = 1-based child position).
      const fallback = c?.kind === "branch" && c?.name == null ? `${name}#${idx + 1}` : null;
      return serializeChild(c, path, fallback);
    }),
  };
}
