/**
 * Pure path operations — no `node:path`, so this module is safe in both the
 * Node target and the browser target.
 *
 * The semantics implemented here are POSIX. The Node target runs on Linux
 * (see systemd/, shell allowlist), so POSIX matches `node:path` there; the
 * browser (OPFS) is POSIX-only regardless. The Node adapter still delegates to
 * `node:path` when platform-perfect behavior matters.
 *
 * `scripts/path-shim-test.ts` asserts this implementation agrees with
 * `node:path.posix` across a broad case list.
 */

export interface PathOps {
  readonly sep: string;
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  isAbsolute(p: string): boolean;
  normalize(p: string): string;
}

const SEP = "/";

function normalizeParts(parts: string[], allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (allowAboveRoot) out.push("..");
    } else {
      out.push(part);
    }
  }
  return out;
}

function normalize(p: string): string {
  if (p.length === 0) return ".";
  const isAbsolute = p.charCodeAt(0) === 47; // "/"
  const trailingSep = p.length > 1 && p.charCodeAt(p.length - 1) === 47;
  const parts = normalizeParts(p.split(SEP), !isAbsolute);
  let result = parts.join(SEP);
  if (result.length === 0) return isAbsolute ? SEP : ".";
  if (isAbsolute) result = SEP + result;
  if (trailingSep && result !== SEP) result += SEP;
  return result;
}

function join(...parts: string[]): string {
  if (parts.length === 0) return ".";
  let joined = "";
  for (const part of parts) {
    if (!part) continue;
    joined = joined.length === 0 ? part : joined + SEP + part;
  }
  return normalize(joined);
}

function resolve(...parts: string[]): string {
  let resolved = "";
  let isAbsolute = false;
  for (let i = parts.length - 1; i >= 0 && !isAbsolute; i--) {
    const part = parts[i];
    if (!part) continue;
    resolved = resolved.length === 0 ? part : part + SEP + resolved;
    isAbsolute = part.charCodeAt(0) === 47;
  }
  if (!isAbsolute) resolved = SEP + resolved;
  return normalize(resolved);
}

function relative(from: string, to: string): string {
  if (from === to) return "";
  const fromAbs = from.charCodeAt(0) === 47;
  const toAbs = to.charCodeAt(0) === 47;
  if (fromAbs !== toAbs) return normalize(to);

  const fromParts = normalizeParts(from.split(SEP), false);
  const toParts = normalizeParts(to.split(SEP), false);

  let common = 0;
  const max = Math.min(fromParts.length, toParts.length);
  while (common < max && fromParts[common] === toParts[common]) common++;

  const up = fromParts.length - common;
  const out: string[] = [];
  for (let i = 0; i < up; i++) out.push("..");
  for (let i = common; i < toParts.length; i++) out.push(toParts[i]);
  return out.join(SEP);
}

function dirname(p: string): string {
  if (p.length === 0) return ".";
  let end = p.length;
  while (end > 1 && p.charCodeAt(end - 1) === 47) end--;
  const isAbsolute = p.charCodeAt(0) === 47;
  let idx = -1;
  for (let i = end - 1; i >= 1; i--) {
    if (p.charCodeAt(i) === 47) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return isAbsolute ? SEP : ".";
  if (idx === 0) return SEP;
  return p.slice(0, idx);
}

function basename(p: string, ext?: string): string {
  let end = p.length;
  while (end > 0 && p.charCodeAt(end - 1) === 47) end--;
  let start = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (p.charCodeAt(i) === 47) {
      start = i + 1;
      break;
    }
  }
  let base = p.slice(start, end);
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, base.length - ext.length);
  return base;
}

function extname(p: string): string {
  let start = 0;
  let dot = -1;
  for (let i = p.length - 1; i >= 0; i--) {
    const c = p.charCodeAt(i);
    if (c === 47) {
      start = i + 1;
      break;
    }
    if (c === 46 && dot === -1) dot = i;
  }
  if (dot === -1 || dot === start) return "";
  return p.slice(dot);
}

function isAbsolute(p: string): boolean {
  return p.length > 0 && p.charCodeAt(0) === 47;
}

export const posixPath: PathOps = {
  sep: SEP,
  resolve,
  join,
  relative,
  dirname,
  basename,
  extname,
  isAbsolute,
  normalize,
};
