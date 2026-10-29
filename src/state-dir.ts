/**
 * The one on-disk state location for the Node side.
 *
 * `BOB_STATE_DIR` overrides it (absolute path); the default is
 * `~/.bobkat`. Everything Node keeps outside a workspace hangs off this:
 * the private `.env`, the Telegram mailbox, the BobSwap credentials and the
 * storage bridge's folder registry (`channels.json`).
 *
 * A twin lives at `web/src/state-dir.ts` for browser-side code, because the
 * standalone boundary (`npm run test:standalone`) forbids `web/` importing
 * from `src/`. Keep the two names in sync.
 */
import os from "node:os";
import path from "node:path";

/** Directory name under the user's home. */
export const STATE_DIR_NAME = ".bobkat";

/** Base state directory: `BOB_STATE_DIR` or `~/.bobkat`. */
export function stateBase(): string {
  return process.env.BOB_STATE_DIR ?? path.join(os.homedir(), STATE_DIR_NAME);
}

/** A path inside the base state directory. */
export function statePath(...segments: string[]): string {
  return path.join(stateBase(), ...segments);
}
