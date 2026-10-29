/**
 * The one on-disk state location for browser-side code.
 *
 * Mirror of `src/state-dir.ts`: the standalone boundary
 * (`npm run test:standalone`) forbids `web/` importing from `src/`, so the
 * name is duplicated here. Keep the two in sync.
 *
 * The browser cannot call `os.homedir()`; desktop paths are written as
 * `~/…` strings and expanded by the storage bridge on the machine that owns
 * the folder.
 */

/** Directory name under the user's home. */
export const STATE_DIR_NAME = ".bobkat";

/** The base state directory as a bridge-expandable `~/…` path. */
export const STATE_HOME = `~/${STATE_DIR_NAME}`;
