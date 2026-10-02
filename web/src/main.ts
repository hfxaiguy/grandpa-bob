/**
 * Milestone 0 smoke test: boot the browser platform, exercise the OPFS
 * workspace through the shared interfaces, and print the result.
 */
import { createBrowserPlatform } from "./platform/browser";

const out = document.getElementById("out")!;
const lines: string[] = [];
const log = (line: string) => {
  lines.push(line);
  out.textContent = lines.join("\n");
};

async function main(): Promise<void> {
  const platform = createBrowserPlatform("/workspace");
  log(`platform: ${platform.kind}`);
  log(`workspace: ${platform.workspaceRoot}`);

  if (!navigator.storage?.getDirectory) {
    log("OPFS is not available in this browser.");
    return;
  }

  const { fs, path } = platform;
  const dir = path.join(platform.workspaceRoot, "notes");
  const file = path.join(dir, "hello.txt");

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, "hello from the browser workspace\n");
  log(`wrote: ${path.relative(platform.workspaceRoot, file)}`);

  const text = await fs.readFile(file);
  log(`read:  ${JSON.stringify(text.trim())}`);

  const stat = await fs.stat(file);
  log(`stat:  isFile=${stat.isFile()} isDirectory=${stat.isDirectory()}`);

  const entries = await fs.readdir(platform.workspaceRoot, { withFileTypes: true });
  log(`workspace entries: ${entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join(", ")}`);

  await fs.rename(file, path.join(dir, "renamed.txt"));
  const afterRename = await fs.readdir(dir, { withFileTypes: true });
  log(`after rename: ${afterRename.map((e) => e.name).join(", ")}`);

  log(`sha256("abc") = ${platform.crypto.sha256hex("abc")}`);
  log("OK");
}

main().catch((err) => {
  log(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
