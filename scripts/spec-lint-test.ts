/**
 * Tests for the narration lint. The rule: every `>>` pause is preceded, in the
 * same branch, by a `<<!` machine emit saying what it waits for.
 *
 * Run: npm run test:spec-lint
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lintSpec, lintWorkspace } from "./spec-lint.js";

// A pause narrated by an immediately-preceding <<! passes.
assert.deepEqual(lintSpec([
  "|| ## turn",
  "|| || <<! { tree: trunk, doing: idle, at: loop_input }",
  "|| || >> loop_input",
].join("\n")), []);

// A pause with no preceding <<! is flagged.
{
  const v = lintSpec([
    "|| || << emit the ask with a Send button",
    "|| || >> reply: press Send, or type what to change",
  ].join("\n"));
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
  assert.match(v[0].pause, />> reply/);
}

// The <<! must be in the same branch (depth matters).
assert.equal(lintSpec(["<<! a top-level note", "|| >> reply"].join("\n")).length, 1);

// Blank lines between the note and the pause are tolerated.
assert.deepEqual(
  lintSpec(["|| <<! { tree: email, doing: waiting, at: reply }", "", "|| >> reply"].join("\n")),
  [],
);

// A << note is not a <<! machine note.
assert.equal(lintSpec(["|| << emit the draft", "|| >> reply"].join("\n")).length, 1);

// Several pauses: only the unnarrated one is flagged.
{
  const v = lintSpec([
    "<<! { tree: trunk, doing: idle, at: start_input }",
    ">> start_input",
    "|| << emit something",
    "|| >> loop_input",
  ].join("\n"));
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 4);
}

// lintWorkspace reads patterns/*.spec.md and app/*/tree.spec.md, skips apps
// without a spec, and reports only the violating file.
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-spec-lint-"));
  try {
    await fs.mkdir(path.join(ws, "patterns"), { recursive: true });
    await fs.writeFile(
      path.join(ws, "patterns", "ok.spec.md"),
      ["<<! { tree: ok, doing: idle, at: start }", ">> start"].join("\n"),
    );
    await fs.mkdir(path.join(ws, "app", "bad"), { recursive: true });
    await fs.writeFile(
      path.join(ws, "app", "bad", "tree.spec.md"),
      ["<< emit the question", ">> reply"].join("\n"),
    );
    await fs.mkdir(path.join(ws, "app", "no-spec"), { recursive: true });

    const report = await lintWorkspace(ws);
    assert.equal(report.length, 1, "only the violating spec is reported");
    assert.equal(report[0].file, path.join("app", "bad", "tree.spec.md"));
    assert.equal(report[0].violations.length, 1);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
}

console.log("spec-lint-test: all assertions passed");
