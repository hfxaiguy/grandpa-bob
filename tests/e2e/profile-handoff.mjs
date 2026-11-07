// E2E live browser test 2 — hand a profile from browser A to browser B through
// the desktop/server peer.
//
//   browser A: create "travel", pair it to the desktop, let the desktop mirror it
//   browser A: close
//   browser B: pair to the same desktop
//   browser B: Preview… → confirm the remote-only profile, pull it from desktop
//
// Two separate Chromium profiles are required: OPFS and localStorage (profile
// registry, device id) are per browser profile, so tabs in one Chrome would be
// the same replica.
//
// Run: `npm run test:e2e-profile-handoff` (needs Chromium and `npm run build:web`).
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  CdpPage,
  adminClient,
  assert,
  buildBridge,
  cleanup,
  createPairingCode,
  createProfileFromUi,
  freePort,
  pairWithDesktop,
  profileRegistry,
  readProfileFile,
  startBob,
  startChrome,
  switchProfile,
  tempDir,
  toggleProfilePeer,
  waitFile,
  waitForProfileFile,
  writeProfileFile,
} from "./lib.mjs";

const tmp = await tempDir("bob-e2e-profile-handoff-");
const stateDir = path.join(tmp, "state");
const workspaceDir = path.join(tmp, "workspace");
const chromeAProfile = path.join(tmp, "chrome-a");
const chromeBProfile = path.join(tmp, "chrome-b");
const roots = [];
roots.push({ dir: tmp });

async function main() {
  await mkdir(stateDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  buildBridge();
  const [appPort, channelPort, cdpPortA, cdpPortB] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const bob = await startBob({ stateDir, workspaceDir, appPort, channelPort });
  roots.push(bob);
  const admin = adminClient({ channelUrl: bob.channelUrl, stateDir });

  const chromeA = await startChrome({ port: cdpPortA, profileDir: chromeAProfile });
  roots.push({ stop: chromeA.stop, dir: chromeAProfile });
  const pageA = await CdpPage.open({ port: cdpPortA, url: bob.appUrl });
  let pairingA = "";
  try {
    // ── browser A: create a profile, then pair it with the desktop ────────
    await pageA.waitForBoot("default");
    await createProfileFromUi(pageA, "travel");
    await writeProfileFile(
      pageA,
      "travel",
      "notes/from-browser-a.txt",
      "this profile started in browser A and travelled through the desktop\n",
    );
    const travelA = (await profileRegistry(pageA)).profiles.find(
      (profile) => profile.name === "travel",
    );
    assert(travelA?.id, "browser A registered the travel profile with an id");

    const codeA = await createPairingCode(admin, { profile: "*" });
    pairingA = codeA.id;
    await pairWithDesktop(pageA, {
      admin,
      channelUrl: bob.channelUrl,
      code: codeA.code,
      profile: "travel",
      pairingId: codeA.id,
    });
    console.log("✓ browser A paired its new profile to the desktop");

    // Allow this local profile to sync with the desktop (the Profiles dialog
    // checkbox), then wait for the mirror to receive the marker file.
    await toggleProfilePeer(pageA, "travel", true);
    await waitFile(path.join(stateDir, "folders", "travel", "notes", "from-browser-a.txt"), 90_000);
    assert(
      (await readFile(path.join(stateDir, "folders", "travel", "notes", "from-browser-a.txt"), "utf8"))
        .includes("browser A"),
      "the desktop mirror holds browser A's workspace",
    );
    const desktopProfiles = await admin("/admin/profiles");
    const travelDesktop = desktopProfiles.profiles.find((profile) => profile.name === "travel");
    assert(travelDesktop, "the desktop catalog lists travel");
    assert(
      travelDesktop.id === travelA.id,
      "the desktop kept browser A's profile id (not a fresh local one)",
    );
    console.log("✓ the desktop mirror is the handoff copy, with A's profile id");

    // Browser A is no longer needed; B must receive the profile from desktop.
    pageA.close();
    chromeA.stop();

    // ── browser B: pair to the desktop, load A's profile through it ───────
    const chromeB = await startChrome({ port: cdpPortB, profileDir: chromeBProfile });
    roots.push({ stop: chromeB.stop, dir: chromeBProfile });
    const pageB = await CdpPage.open({ port: cdpPortB, url: bob.appUrl });
    try {
      await pageB.waitForBoot("default");
      const codeB = await createPairingCode(admin, { profile: "*" });
      await pairWithDesktop(pageB, {
        admin,
        channelUrl: bob.channelUrl,
        code: codeB.code,
        profile: "default",
        pairingId: codeB.id,
      });
      assert(
        !(await profileRegistry(pageB)).profiles.some((profile) => profile.name === "travel"),
        "browser B starts without a travel workspace",
      );

      // The remote-only row: ticking it previews the workspace and asks for
      // confirmation (window.confirm is accepted by the helper). The copy is
      // created with the desktop's profile id, then sync attaches.
      await toggleProfilePeer(pageB, "travel", true);
      await pageB.waitFor(
        `(async () => {
          const root = await navigator.storage.getDirectory();
          const registry = JSON.parse(await (await (await root.getFileHandle("profiles.json")).getFile()).text());
          return registry.profiles.some((profile) => profile.name === "travel");
        })()`,
        "browser B to adopt the remote profile",
        90_000,
      );
      const travelB = (await profileRegistry(pageB)).profiles.find(
        (profile) => profile.name === "travel",
      );
      assert(travelB?.id === travelA.id, "browser B adopted A's profile identity");
      await waitForProfileFile(pageB, "travel", "notes/from-browser-a.txt");
      assert(
        (await readProfileFile(pageB, "travel", "notes/from-browser-a.txt")).includes("browser A"),
        "browser B pulled the workspace from the desktop",
      );
      console.log("✓ browser B loaded A's profile identity and files through the desktop");

      // Switch to it in the UI; the profile remains complete after the reload.
      await switchProfile(pageB, "travel");
      await waitForProfileFile(pageB, "travel", "notes/from-browser-a.txt");
      assert(
        (await readProfileFile(pageB, "travel", "notes/from-browser-a.txt")).includes("browser A"),
        "the profile is still complete after switching to it",
      );
      assert(pageB.exceptions.length === 0, `no page exceptions: ${pageB.exceptions.join(" | ")}`);
      console.log("profile-handoff e2e: A → desktop → B OK");
    } finally {
      pageB.close();
    }
  } finally {
    pageA.close();
    if (pairingA) {
      await admin(`/admin/pairing/${pairingA}/deny`, { method: "POST", body: {} }).catch(() => undefined);
    }
  }
}

main()
  .then(() => cleanup(roots, 0))
  .catch((error) =>
    cleanup(roots, 1, `profile-handoff e2e failed: ${error instanceof Error ? error.stack : error}`),
  );
