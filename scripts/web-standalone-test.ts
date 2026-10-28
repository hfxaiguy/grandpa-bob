// The standalone-only boundary gate: `web/` is self-contained.
//
// The browser app must never reach outside its own tree: imports under
// `web/src` may point into `web/` and `ui/` (the SolidJS app is bundled with
// it) and into bundled npm packages — never back into `../src/` or any other
// repo directory. This is the permanent "standalone-only" guarantee: if it
// fails, the browser target has grown a dependency on the Node side again.
//
// Run: `npm run test:standalone`.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");

/** Every source file the web build pulls in: web/src plus the ui it mounts. */
async function sources(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(path.join(repo, "web/src"));
  await walk(path.join(repo, "ui/src"));
  return out;
}

/** Import/require specifiers in one file (static and dynamic). */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) out.push(match[1]);
  }
  return out;
}

const files = await sources();
const violations: string[] = [];
for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  for (const spec of specifiers(text)) {
    // Relative imports that escape web/ or ui/ are the violation. `ui/src`
    // reaching `../../web/src` is allowed (both are bundled into the app).
    if (!spec.startsWith(".")) continue;
    const base = path.dirname(file);
    const resolved = path.resolve(base, spec);
    const rel = path.relative(repo, resolved);
    const inside = rel.startsWith("web/") || rel.startsWith("ui/");
    if (!inside) {
      violations.push(`${path.relative(repo, file)}: imports "${spec}" → outside web/ + ui/`);
    }
  }
}

// The tsconfig must not sneak ../src files back into the web program either.
const tsconfig = await fs.readFile(path.join(repo, "web/tsconfig.json"), "utf8");
if (/"\.\.\/src\//.test(tsconfig)) {
  violations.push("web/tsconfig.json: include still references ../src/");
}

assert.deepEqual(violations, [], `web/ is not self-contained:\n${violations.join("\n")}`);
console.log(`standalone-only boundary: ${files.length} files clean — web/ imports nothing outside web/ + ui/`);
