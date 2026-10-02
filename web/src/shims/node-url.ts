/** Vite alias target for `node:url`. */
export function pathToFileURL(path: string): URL {
  return new URL(`file://${path}`);
}
export default { pathToFileURL };
