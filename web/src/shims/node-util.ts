/** Vite alias target for `node:util` (only promisify is used by Node-only code). */
export function promisify<T extends (...args: never[]) => unknown>(fn: T) {
  return (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      (fn as unknown as (...a: unknown[]) => void)(...args, (err: unknown, out: unknown) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
}
export default { promisify };
