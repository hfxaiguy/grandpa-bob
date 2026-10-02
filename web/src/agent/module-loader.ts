/**
 * Pattern module loader for the browser.
 *
 * Workspace trees are ESM files that import `grandma-kat` by a filesystem
 * relative path and import sibling modules. The browser has neither, so this
 * loader evaluates them in a small CommonJS-style scope:
 *
 *   - `grandma-kat` (any specifier containing it) -> the statically bundled
 *     grandma-kat namespace, injected as `__gk`;
 *   - `node:*` builtins -> the shims already used by the worker bundle;
 *   - relative specifiers -> resolved and loaded recursively from OPFS;
 *   - `import.meta.url` -> a `file://` URL for the module;
 *   - `export default` / `export const` / `export {}` -> module.exports.
 *
 * It supports the import/export shapes the workspace trees use, not all of ESM.
 */
import * as gk from "grandma-kat";
import fsShim from "../shims/node-fs-promises";
import pathShim from "../shims/node-path";
import cryptoShim from "../shims/node-crypto";
import urlShim from "../shims/node-url";
import osShim from "../shims/node-os";
import type { Platform } from "../../../src/platform/types";

const BUILTINS: Record<string, unknown> = {
  "node:fs": fsShim,
  "node:fs/promises": fsShim,
  "node:path": pathShim,
  "node:crypto": cryptoShim,
  "node:url": urlShim,
  "node:os": osShim,
};

export interface ModuleLoader {
  load(path: string): Promise<Record<string, unknown>>;
}

export function createModuleLoader(platform: Platform): ModuleLoader {
  const cache = new Map<string, Promise<Record<string, unknown>>>();

  const load = (path: string): Promise<Record<string, unknown>> => {
    const abs = platform.path.resolve(platform.workspaceRoot, path);
    let entry = cache.get(abs);
    if (!entry) {
      entry = loadModule(abs);
      cache.set(abs, entry);
    }
    return entry;
  };

  async function exists(abs: string): Promise<boolean> {
    const st = await platform.fs.stat(abs).catch(() => null);
    return !!st?.isFile();
  }

  async function resolveFile(dir: string, spec: string): Promise<string> {
    const base = platform.path.resolve(dir, spec);
    for (const candidate of [base, `${base}.mjs`, `${base}.js`, platform.path.join(base, "index.mjs")]) {
      if (await exists(candidate)) return candidate;
    }
    throw new Error(`module not found: ${spec} (from ${dir})`);
  }

  async function loadModule(abs: string): Promise<Record<string, unknown>> {
    const source = await platform.fs.readFile(abs, "utf8");
    const dir = platform.path.dirname(abs);
    const { code, specs } = transform(source, `file://${abs}`);

    const resolved = new Map<string, unknown>();
    for (const spec of specs) {
      if (spec in BUILTINS) {
        resolved.set(spec, BUILTINS[spec]);
      } else if (spec === "grandma-kat" || spec.includes("grandma-kat")) {
        resolved.set(spec, gk);
      } else if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
        resolved.set(spec, await load(await resolveFile(dir, spec)));
      } else {
        throw new Error(`cannot resolve module specifier: ${spec}`);
      }
    }

    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    const require = (spec: string): unknown => {
      if (!resolved.has(spec)) throw new Error(`module not preloaded: ${spec}`);
      return resolved.get(spec);
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function("require", "module", "exports", "__gk", code);
    fn(require, moduleObj, exportsObj, gk);
    return exportsObj;
  }

  return { load };
}

interface TransformResult {
  code: string;
  specs: string[];
}

function transform(source: string, fileUrl: string): TransformResult {
  const specs: string[] = [];
  let out = source;
  let imp = 0;

  // import.meta.url / dirname
  const dirUrl = fileUrl.slice(0, fileUrl.lastIndexOf("/"));
  out = out.replace(/import\.meta\.url/g, JSON.stringify(fileUrl));
  out = out.replace(/import\.meta\.dirname/g, JSON.stringify(new URL(dirUrl).pathname));

  // import <clause> from "spec";  and  import "spec";
  out = out.replace(
    /^[ \t]*import\s+([^'"]*?)\s*from\s*(['"])([^'"]+)\2[ \t]*;?/gm,
    (_m, clause: string, _q: string, spec: string) => {
      specs.push(spec);
      const tmp = `__imp${imp++}`;
      const parts: string[] = [`const ${tmp} = require(${JSON.stringify(spec)});`];
      let rest = clause.trim();
      const nsMatch = rest.match(/\*\s*as\s+([\w$]+)/);
      if (nsMatch) {
        parts.push(`const ${nsMatch[1]} = ${tmp};`);
        rest = rest.replace(nsMatch[0], "");
      }
      const braced = rest.match(/\{([^}]*)\}/);
      const defaultName = rest.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
      if (defaultName) parts.push(`const ${defaultName} = ${tmp}.default ?? ${tmp};`);
      if (braced) {
        const names = braced[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.replace(/\s+as\s+/, ": "))
          .join(", ");
        if (names) parts.push(`const { ${names} } = ${tmp};`);
      }
      return parts.join(" ");
    },
  );
  out = out.replace(/^[ \t]*import\s*(['"])([^'"]+)\1[ \t]*;?/gm, (_m, _q: string, spec: string) => {
    specs.push(spec);
    return `require(${JSON.stringify(spec)});`;
  });

  // export default X;
  out = out.replace(/^[ \t]*export\s+default\s+(.+?);?[ \t]*$/m, "module.exports.default = $1;");

  // export const/let/var/function/class NAME ...
  const named: string[] = [];
  out = out.replace(
    /^[ \t]*export\s+(const|let|var|function|class)\s+([\w$]+)/gm,
    (_m, kind: string, name: string) => {
      named.push(name);
      return `${kind} ${name}`;
    },
  );

  // export { a, b as c };
  out = out.replace(/^[ \t]*export\s*\{([^}]*)\}[ \t]*;?/gm, (_m, body: string) => {
    const assigns: string[] = [];
    for (const item of body.split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = item.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (m) assigns.push(`module.exports.${m[2] ?? m[1]} = ${m[1]};`);
    }
    return assigns.join(" ");
  });

  if (named.length) {
    out += `\n;Object.assign(module.exports, { ${named.join(", ")} });`;
  }

  return { code: out, specs };
}
