/**
 * Vite alias target and module-loader builtin for `node:sqlite`.
 *
 * SQLite is host-owned in the browser: app data goes through
 * `globalThis.__BOB_STORE__` (sqlite-wasm over OPFS). `DatabaseSync` is
 * synchronous and the host store is async, so it cannot be emulated here.
 * Importing this module is fine — modules that merely pull it in stay
 * bundleable — but opening a database throws with the fix: the module is a
 * Node-only copy, which in practice means the workspace copy is stale.
 */
export class DatabaseSync {
  constructor() {
    throw new Error(
      "node:sqlite is not available in the browser: app database access is host-owned " +
        "(globalThis.__BOB_STORE__). This module opens its own database, so it is a " +
        "Node-only copy — sync the workspace (reload, or open with ?reclone) and retry.",
    );
  }
}
export default { DatabaseSync };
