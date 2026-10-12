// Build the tiled UI (ui/, Vite + SolidJS) into ui/dist, installing its
// dependencies first if they are missing. Chained from `npm run build` and
// `predev` so `/` is always the tiled app when the bot runs.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(root, "ui");

function run(args, cwd) {
  const r = spawnSync("npm", args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
}

if (!existsSync(path.join(ui, "node_modules"))) {
  console.log("[build-ui] ui/node_modules missing — installing ui dependencies…");
  const code = run(["install", "--no-audit", "--no-fund"], ui);
  if (code !== 0) process.exit(code);
}

process.exit(run(["run", "build"], ui));
