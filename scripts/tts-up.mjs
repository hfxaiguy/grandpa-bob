#!/usr/bin/env node
/**
 * Start the local KittenTTS server (`scripts/kitten-tts-server.py`).
 *
 * KittenTTS is a Python library, so `npm run tts:up` needs an interpreter that
 * can `import kittenml`. Picking one is the whole job here:
 *
 *   1. `KITTEN_PYTHON` when set (an explicit interpreter wins outright);
 *   2. `python3` when it already imports kittenml (or the older kittentts);
 *   3. `<state>/tts-venv/bin/python`, provisioned on demand with `uv` — a
 *      system Python is often too new for onnxruntime, so the venv pins 3.12.
 *
 * The server binds loopback only (`127.0.0.1:8185`); see the script's header
 * for KITTEN_TTS_HOST/PORT/MODEL/VOICE.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "kitten-tts-server.py");
const stateDir = process.env.BOB_STATE_DIR?.trim() || path.join(os.homedir(), ".bobkat");
const venvDir = path.join(stateDir, "tts-venv");
const venvDisplay = venvDir.startsWith(os.homedir())
  ? `~${venvDir.slice(os.homedir().length)}`
  : venvDir;
const venvPython = path.join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

function note(text) {
  process.stderr.write(`[tts-up] ${text}\n`);
}

function canImport(python) {
  const probe = spawnSync(python, ["-c", "import kittenml"], {
    stdio: "ignore",
    timeout: 30_000,
  });
  if (probe.status === 0) return true;
  const legacy = spawnSync(python, ["-c", "import kittentts"], {
    stdio: "ignore",
    timeout: 30_000,
  });
  return legacy.status === 0;
}

function which(binary) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [binary], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

/** Build the venv (uv installs its own pinned Python if needed). */
function provisionVenv() {
  if (!which("uv")) {
    note(
      "kittenml is not installed and `uv` is missing.\n" +
        "  install uv (https://docs.astral.sh/uv/), then rerun `npm run tts:up -- --install`\n" +
        "  or point KITTEN_PYTHON at an interpreter that already has kittenml.",
    );
    process.exit(1);
  }
  note(`provisioning ${venvDir} (uv, Python 3.12, kittenml)…`);
  const venv = spawnSync("uv", ["venv", venvDir, "--python", "3.12"], { stdio: "inherit" });
  if (venv.status !== 0) process.exit(venv.status ?? 1);
  const install = spawnSync("uv", ["pip", "install", "--python", venvPython, "kittenml"], {
    stdio: "inherit",
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

function pickPython() {
  const explicit = process.env.KITTEN_PYTHON?.trim();
  if (explicit) return explicit;
  if (canImport("python3")) return "python3";
  if (existsSync(venvPython) && canImport(venvPython)) return venvPython;
  if (!process.argv.includes("--install")) {
    note(
      "kittenml is not installed.\n" +
        `  provision a venv with:  npm run tts:up -- --install\n` +
        `  (uv, Python 3.12, ${venvDisplay}; PyTorch is a large download)\n` +
        "  or point KITTEN_PYTHON at an interpreter that already has kittenml.",
    );
    process.exit(1);
  }
  provisionVenv();
  return venvPython;
}

const python = pickPython();
note(`using ${python}`);
const child = spawn(python, [server], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
