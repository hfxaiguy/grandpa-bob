/**
 * The one seam file tools commit through: wrap `platform.git.autoCommit` and
 * report the paths of a successful commit.
 *
 * `startSync` uses this on the main thread; the agent worker uses it too,
 * because its file tools run in a separate module instance over its own
 * `Platform`. Without the worker half, a file BOB writes would be committed to
 * the local git history but never journaled by the sync engine — paired peers
 * only saw it on the next unrelated round (or not at all).
 */
import type { Platform } from "../platform/types";

export type CommitListener = (paths: string[]) => void;

/** Wrap the platform's commit seam; the returned function uninstalls it. */
export function watchCommits(platform: Platform, listener: CommitListener): () => void {
  const git = platform.git;
  const original = git.autoCommit.bind(git);
  git.autoCommit = async (paths: string[], message: string): Promise<string> => {
    const result = await original(paths, message);
    if (result !== "failed" && result !== "no-changes") listener([...paths]);
    return result;
  };
  return () => {
    git.autoCommit = original;
  };
}
