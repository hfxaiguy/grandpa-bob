// E2E live browser test 1 — a workspace that exists only on the desktop.
//
//   desktop mirror folder (seeded, no browser copy)
//     → fresh browser tab boots
//     → Sync… → Pair… → My desktop/server with the console code
//     → the desktop workspace lands in browser OPFS
//     → the browser creates a pattern through the app
//     → Sync now returns it to the desktop mirror
//
// Run: `npm run test:e2e-desktop-workspace` (needs Chromium and `npm run build:web`).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CdpPage,
  adminClient,
  assert,
  buildBridge,
  cleanup,
  clickSyncNow,
  createPairingCode,
  freePort,
  pairWithDesktop,
  startBob,
  startChrome,
  tempDir,
  waitFile,
  waitForProfileFile,
} from "./lib.mjs";

const tmp = await tempDir("bob-e2e-desktop-workspace-");
const stateDir = path.join(tmp, "state");
const workspaceDir = path.join(tmp, "workspace");
const chromeProfile = path.join(tmp, "chrome");
const roots = [];
roots.push({ dir: tmp });

async function main() {
  await mkdir(stateDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(stateDir, "folders", "default", "notes"), { recursive: true });
  await mkdir(path.join(stateDir, "folders", "default", "patterns"), { recursive: true });
  await writeFile(
    path.join(stateDir, "folders", "default", "notes", "desktop-origin.txt"),
    "this workspace started on the desktop\n",
  );
  await writeFile(
    path.join(stateDir, "folders", "default", "patterns", "desktop-origin.mjs"),
    "export default { from: 'desktop' };\n",
  );

  buildBridge();
  const [appPort, channelPort, cdpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const bob = await startBob({ stateDir, workspaceDir, appPort, channelPort });
  roots.push(bob);
  const chrome = await startChrome({ port: cdpPort, profileDir: chromeProfile });
  roots.push({ stop: chrome.stop, dir: chromeProfile });

  const admin = adminClient({ channelUrl: bob.channelUrl, stateDir });
  const page = await CdpPage.open({ port: cdpPort, url: bob.appUrl });
  let pairingId = "";
  try {
    await page.waitForBoot("default");

    // 1. Pair the fresh tab with the desktop workspace.
    const pairing = await createPairingCode(admin, { exec: ["git", "sh"] });
    pairingId = pairing.id;
    await pairWithDesktop(page, {
      admin,
      channelUrl: bob.channelUrl,
      code: pairing.code,
      profile: "default",
      pairingId: pairing.id,
    });

    // 2. The desktop-only files (and tree) arrive in the browser.
    const desktopNote = await waitForProfileFile(page, "default", "notes/desktop-origin.txt");
    assert(desktopNote.includes("started on the desktop"), "the desktop note arrived");
    const desktopPattern = await waitForProfileFile(page, "default", "patterns/desktop-origin.mjs");
    assert(desktopPattern.includes("from: 'desktop'"), "the desktop pattern came along too");
    console.log("✓ a desktop-only workspace paired into the browser");

    // 3. Interact in the browser: create a pattern through the app's own API.
    const created = await page.evaluate(`(async () => {
      const backend = window.__bobBackend;
      await backend.ready;
      const response = await backend.request(
        "POST", "/api/patterns", new URLSearchParams(),
        JSON.stringify({
          name: "browser-roundtrip",
          content: "export default { from: 'browser' };\\n",
        }),
      );
      return response.status;
    })()`);
    assert(created === 200, `the browser pattern was created (HTTP ${created})`);

    // 4. Sync back to the desktop and inspect the real folder.
    await clickSyncNow(page);
    const mirrored = await waitFile(
      path.join(stateDir, "folders", "default", "patterns", "browser-roundtrip.mjs"),
      90_000,
    );
    assert(
      mirrored.toString("utf8").includes("from: 'browser'"),
      "the browser-created pattern reached the desktop mirror",
    );
    const desktopFile = await readFile(
      path.join(stateDir, "folders", "default", "notes", "desktop-origin.txt"),
      "utf8",
    );
    assert(
      desktopFile.includes("started on the desktop"),
      "the desktop's own files stayed intact",
    );
    const browserRegistry = JSON.parse(
      await page.evaluate(`(async () => {
        const root = await navigator.storage.getDirectory();
        return await (await (await root.getFileHandle("profiles.json")).getFile()).text();
      })()`),
    );
    assert(
      browserRegistry.profiles.some((profile) => profile.name === "default"),
      "the tab still owns its default profile",
    );
    assert(page.exceptions.length === 0, `no page exceptions: ${page.exceptions.join(" | ")}`);
    console.log("✓ browser interaction synced back to the desktop workspace");
    console.log("desktop-workspace e2e: pairing, pull, interaction and push OK");
  } finally {
    page.close();
    if (pairingId) {
      await admin(`/admin/pairing/${pairingId}/deny`, { method: "POST", body: {} }).catch(() => undefined);
    }
  }
}

main()
  .then(() => cleanup(roots, 0))
  .catch((error) =>
    cleanup(roots, 1, `desktop-workspace e2e failed: ${error instanceof Error ? error.stack : error}`),
  );
