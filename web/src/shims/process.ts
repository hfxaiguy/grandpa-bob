/**
 * Minimal `process` global for shared modules that read `process.pid` /
 * `process.env` at call time. Import this first so it is installed before any
 * shared module runs its top level.
 */
const g = globalThis as unknown as { process?: unknown };
g.process ??= {
  env: {},
  pid: 0,
  platform: "browser",
  argv: [],
  cwd: () => "/workspace",
};
