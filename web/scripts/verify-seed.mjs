#!/usr/bin/env node
// Post-build check: the bundle Vite just produced must carry a usable seed.
//
// `prepare-seed.mjs` fills public/seed before the build; Vite copies it to
// dist/seed. This catches a build that skipped the prebuild step, a public
// directory that was cleaned between steps, or a meta/archive mismatch — all
// cases where the app would boot fine but "Update from shipped seed" would
// fail with "seed metadata is not available".
import fs from "node:fs/promises";
import path from "node:path";
import {
  distSeedDir,
  formatBytes,
  parseSeedArchive,
  readJson,
  seedMeta,
} from "./seed-bundle.mjs";

const archiveFile = path.join(distSeedDir, "workspace.json");
const metaFile = path.join(distSeedDir, "meta.json");

function fail(message) {
  console.error(`seed: ${message}`);
  process.exit(1);
}

if (process.env.BOB_SKIP_SEED_BUNDLE === "1") {
  console.log("seed: BOB_SKIP_SEED_BUNDLE=1 — skipping the bundled-seed check");
  process.exit(0);
}

let bytes;
try {
  bytes = await fs.readFile(archiveFile);
} catch {
  fail(
    `the web bundle has no ${path.relative(process.cwd(), archiveFile)}\n` +
      "  run `npm run build` (prebuild fills it); `npm run seed:fetch` refreshes public/seed",
  );
}

let archive;
try {
  archive = parseSeedArchive(bytes, archiveFile);
} catch (err) {
  fail(`${err.message}\n  the web bundle would ship a broken seed`);
}

let meta;
try {
  meta = await readJson(metaFile);
} catch (err) {
  fail(`cannot read ${metaFile}: ${err.message}`);
}

const expected = seedMeta(archive, bytes);
if (
  !meta ||
  meta.version !== expected.version ||
  meta.sha256 !== expected.sha256 ||
  meta.size !== expected.size ||
  meta.fileCount !== expected.fileCount ||
  meta.createdAt !== expected.createdAt
) {
  fail(
    `${metaFile} does not match ${archiveFile}\n` +
      `  expected ${expected.fileCount} files / ${formatBytes(expected.size)} / ${expected.sha256.slice(0, 12)}…\n` +
      `  found    ${meta?.fileCount ?? "?"} files / ${meta?.size ?? "?"} bytes / ${String(meta?.sha256 ?? "?").slice(0, 12)}…\n` +
      "  re-run `npm run seed:fetch` or delete public/seed and rebuild",
  );
}

console.log(
  `seed: verified ${path.relative(process.cwd(), distSeedDir)} — ` +
    `${meta.fileCount} files, ${formatBytes(meta.size)}, ${meta.sha256.slice(0, 12)}…`,
);
