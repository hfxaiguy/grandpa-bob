/**
 * Browser target demo.
 *
 * Milestone 0/1: boot the browser Platform, exercise the OPFS workspace, then
 * run the *existing shared* tree-discovery and versioning modules unchanged by
 * aliasing their node: imports to browser shims.
 */
import "./shims/process";
import { createBrowserPlatform } from "./platform/browser";
import { Tree, name, Prompt, knit } from "grandma-kat";
import { listTreeSources } from "../../src/tree-sources";
import { promoteTree, snapshotTree } from "../../src/tree-versions";

const out = document.getElementById("out")!;
const lines: string[] = [];
const log = (line: string) => {
  lines.push(line);
  out.textContent = lines.join("\n");
};

async function opfsSmoke(root: string): Promise<void> {
  const platform = createBrowserPlatform(root);
  const { fs, path } = platform;

  log(`platform: ${platform.kind}   workspace: ${platform.workspaceRoot}`);
  if (!navigator.storage?.getDirectory) {
    log("OPFS is not available in this browser.");
    return;
  }

  const dir = path.join(root, "notes");
  const file = path.join(dir, "hello.txt");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, "hello from the browser workspace\n");
  const text = await fs.readFile(file);
  log(`fs: wrote/read ${path.relative(root, file)} -> ${JSON.stringify(text.trim())}`);

  await fs.rename(file, path.join(dir, "renamed.txt"));
  const entries = await fs.readdir(dir, { withFileTypes: true });
  log(`fs: notes/ = ${entries.map((e) => e.name).join(", ")}`);
  log(`crypto: sha256("abc") = ${platform.crypto.sha256hex("abc")}`);
}

async function sharedTreesDemo(root: string): Promise<void> {
  const platform = createBrowserPlatform(root);
  const { fs, path } = platform;
  const patterns = path.join(root, "patterns");
  await fs.mkdir(patterns, { recursive: true });
  await fs.writeFile(
    path.join(patterns, "hello.mjs"),
    "// hello.mjs — a demo tree\nexport default 1;\n",
  );
  await fs.writeFile(path.join(patterns, "hello.spec.md"), "# hello\n\nDemo spec.\n");

  log("shared: listTreeSources()");
  const before = (await listTreeSources(root)).filter((s) => s.name === "hello");
  log(`  ${JSON.stringify(before[0] ?? null)}`);

  const snap = await snapshotTree(root, "hello");
  log(`shared: snapshotTree -> ${JSON.stringify(snap)}`);

  const promoted = await promoteTree(root, "hello", snap.version);
  log(`shared: promoteTree -> ${JSON.stringify(promoted)}`);

  const after = (await listTreeSources(root)).filter((s) => s.name === "hello")[0];
  log(`shared: after promote -> prod=${after?.prod} versions=[${after?.versions.join(",")}]`);
}

async function grandmaKatDemo(root: string): Promise<void> {
  // Run a real tree through grandma-kat in the browser with a mock model
  // (logger:false means the node:sqlite stub is never constructed).
  const pattern = Tree(
    name("browser_demo"),
    Prompt((m: { task?: string }) => `task: ${m.task}`),
  );
  const runtime = {
    models: {
      default: {
        model: "mock",
        handler: async (messages: unknown[]) => ({
          content: `hello from grandma-kat (${messages.length} message(s))`,
        }),
      },
    },
    tools: {},
    memory: { task: "say hi" },
    logger: false,
  };
  const { result } = await knit(pattern, runtime);
  log(`grandma-kat: knit -> ${JSON.stringify(result)}`);
}

async function main(): Promise<void> {
  const root = "/workspace";
  await opfsSmoke(root);
  log("");
  await sharedTreesDemo(root);
  log("");
  await grandmaKatDemo(root);
  log("");
  log("OK");
}

main().catch((err) => {
  log(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
