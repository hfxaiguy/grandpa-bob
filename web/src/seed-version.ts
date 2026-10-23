/**
 * Seed freshness: compare the workspace this browser is running against the
 * seed the server currently ships (`/seed/meta.json`).
 *
 * The workspace records the seed's `createdAt` in `/workspace/.seeded` when it
 * is seeded (or the import time when an archive is imported). Comparing that
 * stamp with the shipped seed's `createdAt` answers one question: is the
 * browser running an older workspace than the one on disk? A stale workspace
 * silently keeps old trees — the bug class this check exists to prevent.
 *
 * Pure and DOM-free so it can be unit-tested outside the browser.
 */

export interface SeedMeta {
  version?: number;
  /** ISO timestamp of when the seed was packed. */
  createdAt: string;
  fileCount?: number;
  /** SHA-256 of the exact archive bytes, when the packer recorded one. */
  sha256?: string;
  /** Archive size in bytes, when the packer recorded one. */
  size?: number;
}

export type SeedFreshness = "newer" | "current" | "unknown";

/**
 * Apply-time stamps and build-time stamps come from different clocks (browser
 * vs server); a couple of minutes of skew must not trigger an update offer for
 * a seed the workspace was just created from.
 */
export const SEED_CLOCK_TOLERANCE_MS = 2 * 60 * 1000;

/** Validate a fetched `/seed/meta.json` payload; null when unusable. */
export function parseSeedMeta(raw: unknown): SeedMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  const sha = typeof record.sha256 === "string" ? record.sha256.trim().toLowerCase() : "";
  return {
    version: typeof record.version === "number" ? record.version : undefined,
    createdAt,
    fileCount: typeof record.fileCount === "number" ? record.fileCount : undefined,
    sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : undefined,
    size: typeof record.size === "number" ? record.size : undefined,
  };
}

/**
 * `"newer"` — the shipped seed was built after the workspace's recorded stamp;
 * `"current"` — the workspace already carries this seed (or a newer import);
 * `"unknown"` — no marker (fresh profile: the seeder handles it) or no seed.
 *
 * When both sides carry a content hash (`meta.sha256` from the packer and the
 * `.seed-sha` marker written when an archive was applied), the hash decides:
 * a re-packed seed with the same `createdAt` (same-day rebuild) still differs
 * and must be offered. Without hashes it falls back to the timestamp compare.
 */
export function seedFreshness(
  workspaceStamp: string | null,
  seed: SeedMeta | null,
  toleranceMs: number = SEED_CLOCK_TOLERANCE_MS,
  workspaceSha: string | null = null,
): SeedFreshness {
  if (!seed) return "unknown";
  if (!workspaceStamp) return "unknown";
  const workspaceTime = Date.parse(workspaceStamp);
  if (Number.isNaN(workspaceTime)) return "unknown";

  const localSha = workspaceSha?.trim().toLowerCase();
  if (seed.sha256 && localSha && /^[0-9a-f]{64}$/.test(localSha)) {
    return seed.sha256 === localSha ? "current" : "newer";
  }

  return Date.parse(seed.createdAt) > workspaceTime + toleranceMs ? "newer" : "current";
}
