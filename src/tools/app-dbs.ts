// Databases owned by an app tree. The top-level agent may not reach these
// directly with sql_query / sql_write — it must go through the owning tree,
// which carries the schema and the write rules. A call from inside an app tree
// (`ctx.boundary`) is exempt: the app owns the store. Databases no app owns
// (ad-hoc .db files) stay freely reachable.
//
// Shared by the Node registry (src/tools/index.ts) and the browser worker's
// tool map (web/src/agent/browser-tools.ts) so both targets refuse the same
// stores with the same pointer.

export const APP_OWNED_DBS: Record<string, string> = {
  "contacts.db": "contacts",
  "comms.db": "contacts",
  "email.db": "email",
};

/**
 * What an app-owned store actually holds, when the topic is a poor guide to its
 * contents. A refusal must route the top-level agent to the RIGHT tree, not
 * merely name the file's owner: email.db is sender profiles with no message
 * log, so "who was emailed" is a contacts-tree question. Keys match
 * APP_OWNED_DBS; the hint is appended to the refusal.
 */
const OWNED_DB_HINTS: Record<string, string> = {
  "email.db":
    "email.db holds sender profiles (writing contexts and From addresses), not a message log; " +
    "sent/received history is a contact `message` attribute — ask the contacts tree",
};

/** The app that owns a database path (basename match), or null. */
export function ownedDbApp(pathArg: unknown): { db: string; app: string } | null {
  if (typeof pathArg !== "string") return null;
  const db = pathArg.trim().replace(/^.*[/\\]/, "");
  const app = APP_OWNED_DBS[db];
  return app ? { db, app } : null;
}

/** The refusal an app-owned store returns to the top-level agent. */
export function ownedDbError(owned: { db: string; app: string }): string {
  const hint = OWNED_DB_HINTS[owned.db];
  return (
    `error: "${owned.db}" is owned by the ${owned.app} tree — call the ${owned.app} tree instead of querying it directly.` +
    (hint ? ` ${hint}.` : "")
  );
}
