// Dev launcher: start the Vite dev server and the desktop storage bridge
// together, so the browser target can use either storage mode.
//
//   npm run dev                        # vite + storage-server
//   npm run dev -- /path/to/workspace  # bridge root (default: $WORKSPACE_DIR or ../../workspace)
//   MOCK_LLM=1 npm run dev             # also start the mock LLM (:8787)
//
// Ctrl-C stops everything.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repoRoot = path.resolve(webDir, "..");
const workspace = process.argv[2] ?? process.env.WORKSPACE_DIR ?? path.join(repoRoot, "workspace");

const children = [];
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function run(name, cmd, args) {
  const child = spawn(cmd, args, { cwd: webDir, stdio: "inherit" });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited (${code ?? 0})`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

console.log(`[dev] workspace bridge root: ${workspace}`);
run("vite", "npx", ["vite", "--port", "5173", "--strictPort"]);
run("storage", process.execPath, ["scripts/storage-server.mjs", workspace]);
if (process.env.MOCK_LLM === "1") run("mock-llm", process.execPath, ["mock-llm.mjs"]);
