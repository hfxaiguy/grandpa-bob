/**
 * Browser platform adapter. Wires the shared core to browser primitives:
 *
 *   fs      -> OPFS (see corefs.ts)
 *   path    -> the shared pure POSIX path shim
 *   crypto  -> WebCrypto randomUUID + the shared sync SHA-256
 *   shell   -> virtual coreutils over OPFS
 *   git     -> isomorphic-git over OPFS (local commits)
 *   sqlite  -> sqlite-wasm in a worker, persisted to OPFS
 */
import { posixPath } from "../../../src/platform/paths";
import { sha256hex } from "../../../src/platform/sha256";
import { createCoreutilsShell } from "../../../src/platform/coreutils";
import type { CryptoOps, Platform, SqliteFactory } from "../../../src/platform/types";
import { opfsFs } from "./corefs";
import { createSqliteWasm, initSqlite } from "./sqlite-wasm";
import { createOpfsGit } from "./git-opfs";

export { initSqlite };

const browserCrypto: CryptoOps = {
  randomUUID: () => crypto.randomUUID(),
  sha256hex,
};

const browserSqlite: SqliteFactory = createSqliteWasm();

export function createBrowserPlatform(workspaceRoot = "/workspace"): Platform {
  return {
    kind: "browser",
    path: posixPath,
    fs: opfsFs,
    crypto: browserCrypto,
    shell: createCoreutilsShell({ fs: opfsFs, path: posixPath, workspaceRoot }),
    git: createOpfsGit(workspaceRoot),
    sqlite: browserSqlite,
    workspaceRoot,
  };
}
