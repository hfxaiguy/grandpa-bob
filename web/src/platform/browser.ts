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
import type { CryptoOps, GitOps, Platform, Shell } from "../../../src/platform/types";
import { opfsFs } from "./corefs";

const browserCrypto: CryptoOps = {
  randomUUID: () => crypto.randomUUID(),
  sha256hex,
};

function pending(what: string): (...args: unknown[]) => Promise<never> {
  return async () => {
    throw new Error(`${what} is not implemented in the browser target yet`);
  };
}

const browserShell: Shell = {
  runCommand: pending("run_command") as Shell["runCommand"],
};

const browserGit: GitOps = {
  ensureRepo: pending("git.ensureRepo") as GitOps["ensureRepo"],
  autoCommit: pending("git.autoCommit") as GitOps["autoCommit"],
};

export function createBrowserPlatform(workspaceRoot = "/workspace"): Platform {
  return {
    kind: "browser",
    path: posixPath,
    fs: opfsFs,
    crypto: browserCrypto,
    shell: browserShell,
    git: browserGit,
    workspaceRoot,
  };
}
