// Pure reconcile logic for the desktop mirror.
//
// The workspace always lives in the tab's OPFS; a desktop mirror is a folder
// kept in sync through the storage bridge. The browser's OPFS copy is
// canonical: when both sides changed a path since the last sync, the browser's
// bytes win and the bridge preserves the desktop variant as a `.conflict-*`
// copy next to it (excluded from later syncs).
//
// A plan is computed from three manifests, each `{ path: { hash, bytes } }`:
//   base   — what the bridge recorded after the last successful sync
//   mine   — the browser's current workspace
//   theirs — the mirror folder on the desktop
//
// Paths are workspace-relative POSIX paths. Hashing matches the browser's
// sync hashmap: sha256 over the file's base64 text, so the two sides agree.

/** Never mirrored (each replica keeps its own history/run log/attachments). */
export const MIRROR_EXCLUDED = [
  /^\.git\//,
  /^\.gpb-/,
  /^logs\//,
  /^assets\/inbox\//,
  /(^|\/)\.gpb-sync\//,
  /\.conflict-[0-9T-]+$/,
];

export function mirrorExcluded(rel) {
  return MIRROR_EXCLUDED.some((re) => re.test(rel));
}

/** Validate a manifest: plain object of `{hash: string, bytes: number}`. */
export function parseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest must be an object");
  }
  const out = {};
  for (const [path, entry] of Object.entries(value)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.hash) ||
      typeof entry.bytes !== "number" ||
      !Number.isFinite(entry.bytes) ||
      entry.bytes < 0
    ) {
      throw new Error(`manifest entry ${path}: expected {hash, bytes}`);
    }
    out[path] = { hash: entry.hash, bytes: Math.floor(entry.bytes) };
  }
  return out;
}

/**
 * Which paths to move, from the browser's point of view.
 *
 * `pull`/`pullDeletes` are the bridge's changes to apply here; `push`/
 * `pushDeletes` are this workspace's changes to send back; `conflicts` names
 * paths both sides changed (OPFS wins; the bridge keeps the loser).
 */
export function diffMirror(base, mine, theirs) {
  const pull = [];
  const pullDeletes = [];
  const push = [];
  const pushDeletes = [];
  const conflicts = [];
  const paths = new Set([
    ...Object.keys(base),
    ...Object.keys(mine),
    ...Object.keys(theirs),
  ]);

  for (const path of paths) {
    const b = base[path];
    const m = mine[path];
    const t = theirs[path];
    const mh = m?.hash;
    const th = t?.hash;
    const bh = b?.hash;
    if (mh === th) continue; // same bytes (or absent on both sides)
    const mineChanged = mh !== bh;
    const theirsChanged = th !== bh;

    if (mineChanged && !theirsChanged) {
      if (m) push.push(path);
      else pushDeletes.push(path);
      continue;
    }
    if (!mineChanged && theirsChanged) {
      if (t) pull.push(path);
      else pullDeletes.push(path);
      continue;
    }
    // Both moved (or this is the first sync with different bytes): OPFS wins.
    conflicts.push(path);
    if (m) push.push(path);
    else pushDeletes.push(path);
  }

  const sort = (list) => list.sort();
  return {
    pull: sort(pull),
    pullDeletes: sort(pullDeletes),
    push: sort(push),
    pushDeletes: sort(pushDeletes),
    conflicts: sort(conflicts),
  };
}
