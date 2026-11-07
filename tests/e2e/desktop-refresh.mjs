// E2E live browser test — a desktop pairing must survive a page refresh.
//
//   desktop workspace (seeded)
//     → fresh browser tab boots
//     → Sync… → Pair… → My desktop/server, over a local relay
//     → the desktop-only note arrives in browser OPFS
//     → RELOAD the page
//     → the same pairing reconnects with no code and no operator step
//     → a browser change still reaches the desktop mirror
//
// The local mock relay stands in for BobSwap so the test is deterministic and
// offline; the relay pairing path is the one a reload has to survive.
//
// Run: `npm run test:e2e-desktop-refresh` (needs Chromium and `npm run build:web`).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CdpPage,
  adminClient,
  assert,
  buildBridge,
  cleanup,
  clickSyncNow,
  freePort,
  approveDesktopPairing,
  startBob,
  startChrome,
  startDesktopPairing,
  startMockRelay,
  tempDir,
  waitFile,
  waitForProfileFile,
} from "./lib.mjs";

const tmp = await tempDir("bob-e2e-desktop-refresh-");
const stateDir = path.join(tmp, "state");
const workspaceDir = path.join(tmp, "workspace");
const chromeProfile = path.join(tmp, "chrome");
const roots = [{ dir: tmp }];

async function main() {
  await mkdir(path.join(stateDir, "folders", "default", "notes"), { recursive: true });
  await writeFile(
    path.join(stateDir, "folders", "default", "notes", "desktop-origin.txt"),
    "this workspace started on the desktop\n",
  );

  buildBridge();
  const relay = await startMockRelay();
  roots.push({ stop: () => relay.close() });
  const [appPort, channelPort, cdpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const bob = await startBob({ stateDir, workspaceDir, appPort, channelPort });
  roots.push(bob);
  const chrome = await startChrome({ port: cdpPort, profileDir: chromeProfile });
  roots.push({ stop: chrome.stop, dir: chromeProfile });

  const admin = adminClient({ channelUrl: bob.channelUrl, stateDir });
  const page = await CdpPage.open({ port: cdpPort, url: bob.appUrl });
  // Keep the page's console lines: a failed browser-side join only shows there.
  const browserLog = [];
  const inner = page.ws.onmessage;
  page.ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ");
        browserLog.push(`${message.params.type}: ${text}`);
      }
    } catch {
      /* ignore */
    }
    inner(event);
  };
  await page.send("Runtime.enable");
  let pairingId = "";
  try {
    await page.waitForBoot("default");

    // 1. Pair the tab with the desktop over the relay (the path a reload must
    //    keep alive without a new code).
    const pairing = await admin("/admin/pairing", {
      method: "POST",
      body: { profile: "*", exec: [], relay: { url: relay.url, key: "test-read-key" } },
    });
    pairingId = pairing.id;
    await startDesktopPairing(page, { channelUrl: relay.url, code: pairing.code });
    await approveDesktopPairing(page, admin, pairing.id, { timeout: 120_000 });
    await page.waitFor(
      `(() => {
        const chip = document.getElementById("mirror-status");
        return chip && !chip.hidden && (chip.textContent || "").startsWith("desktop:") &&
          !(chip.textContent || "").includes("pairing needed");
      })()`,
      "the desktop link after pairing",
      120_000,
    );
    const pairedNote = await waitForProfileFile(page, "default", "notes/desktop-origin.txt");
    assert(pairedNote.includes("started on the desktop"), "the desktop note arrived before the refresh");
    assert(
      await page.evaluate(`!!localStorage.getItem("bob:server:default")`),
      "the pairing credentials are stored for this profile",
    );
    console.log("✓ paired with the desktop; the desktop workspace arrived");

    // 2. Refresh the page — the exact thing that used to drop the pair.
    await page.reload();
    await page.waitForBoot("default");

    // 3. The same pairing must reconnect by itself: a ready live link, a
    //    connected chip, and no "pairing needed" toast state.
    const link = await page.waitFor(
      `(() => {
        const diag = window.__bobSync?.diagnostics?.() ?? null;
        const live = (diag?.links ?? []).find((entry) => entry.ready);
        const chip = document.getElementById("mirror-status");
        const text = chip?.textContent ?? "";
        if (!live || !chip || chip.hidden) return false;
        if (!text.startsWith("desktop:") || /pairing needed|disconnected|offline/i.test(text)) return false;
        return { deviceId: live.deviceId, profiles: live.profiles.length };
      })()`,
      "the desktop link after the refresh",
      120_000,
    );
    assert(link && link.profiles > 0, "the refreshed tab reattached the desktop profile");
    assert(
      await page.evaluate(`!!localStorage.getItem("bob:server:default")`),
      "the stored pairing survived the refresh",
    );
    // The Sync dialog must still list the desktop, and as connected.
    const devices = await page.waitFor(
      `(() => {
        const dialog = document.getElementById("sync-dialog");
        if (!dialog?.open) document.getElementById("sync-menu")?.click();
        const list = document.getElementById("paired-device-list");
        const items = [...(list?.querySelectorAll("li.paired-device") ?? [])];
        if (!list || list.hidden || !items.length) return false;
        return {
          count: items.length,
          online: items.filter((item) => item.dataset.online === "true").length,
        };
      })()`,
      "the paired desktop in the Sync dialog",
      60_000,
    );
    assert(devices.online > 0, "the refreshed tab still lists the desktop as connected");
    console.log("✓ after a refresh the tab reconnected to the desktop without a new code");

    // 4. Prove the datachannel is usable, not just registered: a change made
    //    in the refreshed tab must still reach the desktop mirror.
    const created = await page.evaluate(`(async () => {
      const backend = window.__bobBackend;
      await backend.ready;
      const response = await backend.request(
        "POST", "/api/patterns", new URLSearchParams(),
        JSON.stringify({
          name: "after-refresh",
          content: "export default { from: 'refreshed-tab' };\\n",
        }),
      );
      return response.status;
    })()`);
    assert(created === 200, `the refreshed tab created a pattern (HTTP ${created})`);
    await clickSyncNow(page);
    const mirrored = await waitFile(
      path.join(stateDir, "folders", "default", "patterns", "after-refresh.mjs"),
      90_000,
    );
    assert(
      mirrored.toString("utf8").includes("from: 'refreshed-tab'"),
      "the change from the refreshed tab reached the desktop mirror",
    );
    const desktopFile = await readFile(
      path.join(stateDir, "folders", "default", "notes", "desktop-origin.txt"),
      "utf8",
    );
    assert(desktopFile.includes("started on the desktop"), "the desktop's own files stayed intact");
    assert(page.exceptions.length === 0, `no page exceptions: ${page.exceptions.join(" | ")}`);
    console.log("✓ the refreshed pairing still syncs workspace changes both ways");
    console.log("desktop-refresh e2e: pair, refresh, reconnect and sync OK");
  } catch (error) {
    console.error(`mock relay requests (last 40):\n${relay.requests.slice(-40).join("\n")}`);
    console.error(`browser console (last 40):\n${browserLog.slice(-40).join("\n")}`);
    throw error;
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
    cleanup(roots, 1, `desktop-refresh e2e failed: ${error instanceof Error ? error.stack : error}`),
  );
