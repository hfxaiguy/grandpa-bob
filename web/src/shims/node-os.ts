/** Vite alias target for `node:os`. */
export function homedir(): string {
  return "/home/bob";
}
export function tmpdir(): string {
  return "/tmp";
}
export default { homedir, tmpdir };
