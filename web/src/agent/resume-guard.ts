/**
 * Whether a failed resume means the saved pause point is dead and the turn
 * should grow a fresh tree instead of surfacing the error to the chat.
 *
 * Two shapes are recoverable, both "the tree changed, not the request":
 *   - the checkpoint row is gone (`checkpoint '…' not found`) — the run log
 *     was cleared or pruned under us; and
 *   - the checkpoint exists but its paused tree stack cannot be rebuilt
 *     (`cannot resume: tree '…' is not registered`) — a stale sub-tree
 *     auto-name, or an app/pattern tree edited, renamed or re-versioned
 *     while the session was paused.
 *
 * Anything else is a genuine failure and must propagate. This lives under
 * `web/` (the only agent host) rather than `src/` because the standalone
 * boundary gate forbids the browser app importing the Node channel code.
 */
export function isDroppableContinuationError(message: string): boolean {
  return /checkpoint/i.test(message) || /cannot resume/i.test(message);
}
