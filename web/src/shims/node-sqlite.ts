/**
 * Vite alias target for `node:sqlite`. Not implemented yet — milestone 2
 * replaces this with sqlite-wasm over OPFS. Throwing here keeps modules that
 * merely import it (grandma-kat's logger) bundleable until then.
 */
export class DatabaseSync {
  constructor() {
    throw new Error("node:sqlite is not available in the browser yet (see milestone 2: sqlite-wasm)");
  }
}
export default { DatabaseSync };
