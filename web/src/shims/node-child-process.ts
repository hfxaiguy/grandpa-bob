/**
 * Vite alias target for `node:child_process`. The browser has no processes;
 * milestone 5 provides virtual coreutils over OPFS. Throwing keeps modules
 * that import it bundleable.
 */
export function execFile(): never {
  throw new Error("child_process is not available in the browser (see milestone 5: virtual coreutils)");
}
export function spawn(): never {
  throw new Error("child_process is not available in the browser (see milestone 5: virtual coreutils)");
}
export default { execFile, spawn };
