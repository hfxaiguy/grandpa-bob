/** Vite alias target for `node:url`. */
export function pathToFileURL(p: string): URL {
  return new URL(`file://${p.startsWith("/") ? p : `/${p}`}`);
}

export function fileURLToPath(input: string | URL): string {
  const url = input instanceof URL ? input : new URL(String(input));
  return decodeURIComponent(url.pathname);
}

export default { pathToFileURL, fileURLToPath };
