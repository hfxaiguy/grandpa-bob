/**
 * Browser platform adapter. Wires the shared core to browser primitives:
 *
 *   fs      -> OPFS (see corefs.ts)
 *   path    -> the shared pure POSIX path shim
 *   crypto  -> WebCrypto randomUUID + the shared sync SHA-256
 *   shell   -> virtual coreutils (milestone 5)
 *   git     -> isomorphic-git (milestone 5)
 *
 * Shell and git throw until their milestones land.
 */
import { posixPath } from "../../../src/platform/paths";
import { sha256hex } from "../../../src/platform/sha256";
import { createCoreutilsShell } from "../../../src/platform/coreutils";
import type { CryptoOps, GitOps, Platform, Shell, SqliteFactory } from "../../../src/platform/types";
import { opfsFs } from "./corefs";
import { createSqliteWasm, initSqlite } from "./sqlite-wasm";

export { initSqlite };

const browserCrypto: CryptoOps = {
  randomUUID: () => crypto.randomUUID(),
  sha256hex,
};

function pending(what: string): (...args: unknown[]) => Promise<never> {
  return async () => {
    throw new Error(`${what} is not implemented in the browser target yet`);
  };
}

const browserShell: Shell = createCoreutilsShell({
  fs: opfsFs,
  path: posixPath,
  workspaceRoot: "/workspace",
});

const browserGit: GitOps = {
  ensureRepo: pending("git.ensureRepo") as GitOps["ensureRepo"],
  autoCommit: pending("git.autoCommit") as GitOps["autoCommit"],
};

const browserSqlite: SqliteFactory = createSqliteWasm();

export function createBrowserPlatform(workspaceRoot = "/workspace"): Platform {
  return {
    kind: "browser",
    path: posixPath,
    fs: opfsFs,
    crypto: browserCrypto,
    shell: browserShell,
    git: browserGit,
    sqlite: browserSqlite,
    workspaceRoot,
  };
}
