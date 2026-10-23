/**
 * spec-lint.ts — a static check across the workspace's tree header specs.
 *
 * A tree's notation lives in its leading `//` comment block (its spec); the
 * lint reads that block from every `*.prod.mjs` tree file.
 *
 * The narration invariant: a tree that pauses must say, in a machine emit
 * (`<<!`), what it is waiting for. An input arriving at a `>>` pause with no
 * immediately-preceding machine note has nothing to be routed against.
 *
 *   npm run lint:specs                 # $WORKSPACE_DIR or ~/grandma-workspace
 *   npm run lint:specs -- /path/to/ws  # explicit workspace
 *
 * This is workspace tooling, not runtime code: it lives here rather than in
 * the workspace's `lib/` so it is not packed into the browser seed.
 */
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SpecViolation {
  line: number;
  pause: string;
  saw: string;
}

export interface SpecReport {
  file: string;
  violations: SpecViolation[];
}

/** Nesting depth of a notation line: how many leading `||` tokens it carries. */
function depth(line: string): number {
  const lead = line.match(/^\s*((?:\|\|\s*)*)/);
  return lead ? (lead[1].match(/\|\|/g) ?? []).length : 0;
}

const isHumanPause = (line: string): boolean => /^\s*(?:\|\|\s*)*>>/.test(line);
const isMachineEmit = (line: string): boolean => /^\s*(?:\|\|\s*)*<<!/.test(line);

/**
 * Every `>>` human pause must be immediately preceded, in the same branch, by
 * a `<<!` machine emit saying what the pause waits for. Blank lines between
 * the note and the pause are tolerated; anything else (a step, a comment, a
 * differently-indented note) is a violation.
 */
export function lintSpec(text: string): SpecViolation[] {
  const lines = String(text ?? "").split("\n");
  const violations: SpecViolation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isHumanPause(lines[i])) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j -= 1;
    const prev = j >= 0 ? lines[j] : null;
    const narrated = prev !== null && isMachineEmit(prev) && depth(prev) === depth(lines[i]);
    if (!narrated) {
      violations.push({
        line: i + 1,
        pause: lines[i].trim(),
        saw: prev === null ? "(start of spec)" : prev.trim(),
      });
    }
  }
  return violations;
}

/** Default workspace: the same override the bot uses, else ~/grandma-workspace. */
export function defaultWorkspace(): string {
  return process.env.WORKSPACE_DIR || path.join(os.homedir(), "grandma-workspace");
}

/** The tree's notation block: leading `//` comments from the `##` header down. */
export function headerSpecOf(moduleText: string): string {
  const out: string[] = [];
  for (const line of String(moduleText ?? "").split("\n")) {
    if (line.startsWith("//")) out.push(line.replace(/^\/\/ ?/, ""));
    else if (!line.trim() && out.length === 0) continue;
    else break;
  }
  const at = out.findIndex((line) => /^\s*##\s+\S/.test(line));
  return (at >= 0 ? out.slice(at) : out).join("\n");
}

/** Lint every tree header under `dir` — patterns and each app's tree. */
export async function lintWorkspace(dir = defaultWorkspace()): Promise<SpecReport[]> {
  const files: string[] = [];

  const patternsDir = path.join(dir, "patterns");
  try {
    for (const f of await readdir(patternsDir)) {
      if (f.endsWith(".prod.mjs")) files.push(path.join(patternsDir, f));
    }
  } catch {
    // no patterns directory
  }

  const appDir = path.join(dir, "app");
  try {
    for (const entry of await readdir(appDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      files.push(path.join(appDir, entry.name, "tree.prod.mjs"));
    }
  } catch {
    // no app directory
  }

  const out: SpecReport[] = [];
  for (const abs of files.sort()) {
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      continue; // apps without a tree are skipped
    }
    const violations = lintSpec(headerSpecOf(text));
    if (violations.length) out.push({ file: path.relative(dir, abs), violations });
  }
  return out;
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? defaultWorkspace();
  const report = await lintWorkspace(dir);
  if (!report.length) {
    console.log(`spec-lint: ok — every pause is narrated (${dir})`);
    return;
  }
  let n = 0;
  for (const { file, violations } of report) {
    console.log(`\n${file}`);
    for (const v of violations) {
      n += 1;
      console.log(`  line ${v.line}: no <<! before "${v.pause}" (saw: ${v.saw})`);
    }
  }
  console.log(`\nspec-lint: ${n} unnarrated pause(s) in ${report.length} file(s)`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
