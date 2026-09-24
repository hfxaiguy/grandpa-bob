/**
 * Shell argument sandbox: run_command rejects path-like arguments that
 * resolve outside the workspace (absolute paths, ~, ../) — execFile never
 * sandboxes arguments by itself — while inside paths keep working.
 *
 * Run: npm run test:shell
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShellTools } from "../src/tools/shell.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-shell-"));
await fs.mkdir(path.join(ws, "sub"), { recursive: true });
await fs.writeFile(path.join(ws, "note.txt"), "inside\n");
await fs.writeFile(path.join(ws, "sub", "deep.txt"), "deep\n");

{
  const shell = new ShellTools(ws, ["cat", "ls", "find", "grep", "git", "echo", "pwd"]);

  // Inside paths still execute for real.
  const ok = await shell.runCommand("cat", ["note.txt"]);
  assert.match(ok, /inside/);
  const okAbs = await shell.runCommand("cat", [path.join(ws, "sub", "deep.txt")]);
  assert.match(okAbs, /deep/);
  const okNav = await shell.runCommand("cat", ["./sub/../note.txt"]);
  assert.match(okNav, /inside/);

  // Escapes are rejected before execFile ever runs.
  const cases: [string, string[]][] = [
    ["cat /etc/passwd", ["cat", ["/etc/passwd"]]],
    ["cat ../../etc/passwd", ["cat", ["../../etc/passwd"]]],
    ["cat ~/.grandpa-bob/.env", ["cat", ["~/.grandpa-bob/.env"]]],
    ["cat ~", ["cat", ["~"]]],
    ["find / -name x", ["find", ["/", "-name", "x"]]],
    ["git -C /tmp status", ["git", ["-C", "/tmp", "status"]]],
    ["cat --file=/etc/hosts", ["cat", ["--file=/etc/hosts"]]],
    ["grep /etc/passwd note.txt", ["grep", ["/etc/passwd", "note.txt"]]],
  ];
  for (const [label, [cmd, args]] of cases) {
    await assert.rejects(
      () => shell.runCommand(cmd, args),
      /escapes the workspace/,
      `reject: ${label}`,
    );
  }
  console.log("shell sandbox: inside paths run, escapes rejected (incl. =value and ~)");
}

console.log("shell-sandbox-test: all assertions passed");
