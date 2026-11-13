// Shared helpers for the seed that ships inside the web bundle.
//
// `web/public/seed/` is generated (make-seed writes it locally; a clean
// checkout fetches the public shelf instead), so the build validates the
// archive before Vite copies it into `web/dist/seed/`.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const publicDir = path.resolve(here, "..", "public");
export const distDir = path.resolve(here, "..", "dist");
export const seedDir = path.join(publicDir, "seed");
export const archivePath = path.join(seedDir, "workspace.json");
export const metaPath = path.join(seedDir, "meta.json");
export const bootstrapPath = path.join(publicDir, "seed-bootstrap.json");
export const distSeedDir = path.join(distDir, "seed");

/** The tree entry boot's "is this workspace usable?" check expects. */
const TRUNK_PATH = "workspace/patterns/trunk.prod.mjs";

/** Parse and sanity-check a WorkspaceArchive; throw a message worth showing. */
export function parseSeedArchive(bytes, label = "seed archive") {
  let archive;
  try {
    archive = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!archive || typeof archive !== "object") {
    throw new Error(`${label} is not a workspace archive`);
  }
  if (archive.version !== 1) {
    throw new Error(`${label} has unsupported version ${archive.version ?? "(missing)"}`);
  }
  if (typeof archive.createdAt !== "string" || Number.isNaN(Date.parse(archive.createdAt))) {
    throw new Error(`${label} has no usable createdAt timestamp`);
  }
  if (!Array.isArray(archive.files) || archive.files.length === 0) {
    throw new Error(`${label} has no files`);
  }
  let trunk = false;
  for (const entry of archive.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.base64 !== "string") {
      throw new Error(`${label} has a malformed file entry`);
    }
    if (!entry.path.startsWith("workspace/")) {
      throw new Error(`${label} entry is outside workspace/: ${entry.path}`);
    }
    if (entry.path === TRUNK_PATH) trunk = true;
  }
  if (!trunk) {
    throw new Error(`${label} has no ${TRUNK_PATH}`);
  }
  return archive;
}

/** The sidecar `/seed/meta.json` record for an archive. */
export function seedMeta(archive, bytes) {
  return {
    version: archive.version,
    createdAt: archive.createdAt,
    fileCount: archive.files.length,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function formatBytes(value) {
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(value / 1024))} KiB`;
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
