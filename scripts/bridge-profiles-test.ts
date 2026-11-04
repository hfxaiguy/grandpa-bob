/**
 * Desktop-side profile catalog: UUID manifests, folder adoption, consent and
 * the one-time relink. Runs against a temporary BOB_STATE_DIR.
 *
 * Run: `npm run test:bridge-profiles`.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "bob-bridge-profiles-"));
process.env.BOB_STATE_DIR = stateDir;

const {
  bridgeCatalog,
  bridgeConsent,
  bridgeDeviceId,
  ensureBridgeProfile,
  listBridgeProfiles,
  readProfileManifest,
  relinkBridgeProfile,
  setBridgeProfileConsent,
} = await import("../src/bridge/profiles.js");

try {
  const travel = await ensureBridgeProfile("travel");
  assert.match(travel.id, /^[0-9a-f-]{36}$/);
  assert.equal(travel.name, "travel");
  const manifest = await readProfileManifest(travel.folder);
  assert.equal(manifest?.id, travel.id, "the folder gets an identity manifest");

  const again = await ensureBridgeProfile("travel");
  assert.equal(again.id, travel.id, "ensuring an existing profile keeps its id");

  // A pre-existing folder with no profiles.json entry is adopted by name.
  const legacy = path.join(stateDir, "folders", "legacy");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "workspace.txt"), "hello");
  const profiles = await listBridgeProfiles();
  const adopted = profiles.find((profile) => profile.name === "legacy");
  assert.ok(adopted, "a folder root is adopted as a profile");
  assert.equal((await readProfileManifest(adopted!.folder))?.id, adopted!.id);

  const device = await bridgeDeviceId();
  assert.match(device, /^[0-9a-f-]{36}$/);
  assert.equal(await bridgeDeviceId(), device, "the device id is stable");

  assert.equal((await bridgeConsent(device))[travel.id], true, "headless default is allow");
  await setBridgeProfileConsent(travel.id, device, false);
  assert.equal((await bridgeConsent(device))[travel.id], false);

  const relinked = await relinkBridgeProfile(
    travel.id,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(relinked?.id, "22222222-2222-4222-8222-222222222222");
  assert.equal(
    (await readProfileManifest(travel.folder))?.id,
    "22222222-2222-4222-8222-222222222222",
    "the manifest follows the relink",
  );
  assert.deepEqual(
    (await bridgeCatalog()).find((entry) => entry.name === "travel")?.id,
    "22222222-2222-4222-8222-222222222222",
  );

  const file = JSON.parse(await readFile(path.join(stateDir, "profiles.json"), "utf8"));
  assert.equal(file.version, 1);
  assert.ok(Array.isArray(file.profiles));

  console.log("bridge-profiles: manifests, adoption, consent and relink OK");
} finally {
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});
}
