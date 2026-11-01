/**
 * Tool scoping for the fractal app folders.
 *
 * App discovery keeps every `app/…/app/…/tree.prod.mjs` as its own tree,
 * tagged with the nearest ancestor that bears a tree (`parent`). The host
 * turns that tree into the tool board:
 *
 *  - the trunk (and every other non-app pattern) sees only top-level app
 *    trees — a sub-app is never a tool of the chat root;
 *  - an app tree sees the app trees directly below it, so the parent drives
 *    its sub-apps the same way the trunk drives the top-level apps.
 *
 * The rule is applied to an already-built tree definition (grandma-kat's
 * `tools` array of `{ cond, value, position }`), so it survives the engine's
 * static validation and works for dynamically loaded trees and resumes.
 */
export interface AppLink {
  name: string;
  parent?: string | null;
}

export interface TreeToolRule {
  cond?: unknown;
  value?: string[];
  position?: number;
}

export interface ScopedTree {
  name?: string | null;
  tools?: TreeToolRule[];
  children?: ScopedTree[];
}

/** Names of every app that lives below another app. */
function nestedNames(apps: readonly AppLink[]): Set<string> {
  return new Set(apps.filter((a) => a.parent != null).map((a) => a.name));
}

/** Direct sub-apps of one tree (never grandchildren). */
function childNames(apps: readonly AppLink[], parent: string): string[] {
  return apps.filter((a) => a.parent === parent).map((a) => a.name);
}

/**
 * Remove tool names below another app unless this tree is allowed to drive
 * them. Function tools and top-level app names are untouched — only names
 * discovered as nested app trees are in scope here.
 */
function scrubRules(tree: ScopedTree, nested: Set<string>, allowed: Set<string>): void {
  if (Array.isArray(tree.tools)) {
    for (const rule of tree.tools) {
      if (!Array.isArray(rule.value)) continue;
      rule.value = [...new Set(rule.value.filter((name) => !nested.has(name) || allowed.has(name)))];
    }
  }
  for (const child of Array.isArray(tree.children) ? tree.children : []) {
    scrubRules(child, nested, allowed);
  }
}

/**
 * Make a tree definition obey the app boundary:
 *  - non-app patterns (the trunk, `trunk_ask`, any other root pattern) lose
 *    every sub-app tool name;
 *  - app trees keep their own declared tools and gain their direct sub-apps.
 *
 * `selfName` is the logical name the host used to load the tree; pass it when
 * a tree's internal `name(...)` can differ from its folder (the dashed
 * `caller-list` folder names its tree `caller_list`).
 *
 * Mutates and returns `def`; callers load a tree once and cache the result.
 */
export function scopeTreeTools<T>(def: T, apps: readonly AppLink[], selfName?: string | null): T {
  if (!def || typeof def !== "object") return def;
  const tree = def as ScopedTree;
  const treeName = typeof tree.name === "string" ? tree.name : "";
  const exact = [selfName, treeName].filter((n): n is string => !!n);
  const candidates = exact.map((n) => n.replace(/_/g, "-"));
  const self =
    selfName === null
      ? ""
      : (apps.find((a) => exact.includes(a.name))?.name ??
        apps.find((a) => candidates.includes(a.name.replace(/_/g, "-")))?.name ??
        "");
  const isApp = self.length > 0;
  const nested = nestedNames(apps);
  // A non-app pattern may drive only top-level apps. An app may name its
  // direct children; everything deeper stays unreachable.
  const allowed = new Set(
    isApp ? childNames(apps, self) : apps.filter((a) => a.parent == null).map((a) => a.name),
  );
  scrubRules(tree, nested, allowed);

  if (isApp) {
    const kids = childNames(apps, self);
    if (kids.length > 0) {
      const rules = Array.isArray(tree.tools) ? tree.tools : (tree.tools = []);
      // Merge into the existing unconditional rule so the engine does not
      // warn about a later rule shadowing the app's own `Tools(...)`.
      const open = [...rules].reverse().find((rule) => rule.cond == null);
      if (open) {
        open.value = [...new Set([...(Array.isArray(open.value) ? open.value : []), ...kids])];
      } else {
        // No unconditional rule: grant the children from the start. A rule at
        // position 0 is visible to the whole tree and shadows nothing before it.
        rules.unshift({ cond: null, value: [...new Set(kids)], position: 0 });
      }
    }
  }
  return def;
}
