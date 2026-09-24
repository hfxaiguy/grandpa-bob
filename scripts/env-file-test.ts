/**
 * .env file precedence: ENV_FILE override > ~/.grandpa-bob/.env >
 * <projectDir>/.env. The resolved file is what config loads and what the
 * settings-page editor writes.
 *
 * Run: npm run test:env
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveEnvFile } from "../src/env-file.js";

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "gpb-env-"));
const root = path.join(ws, "project");
const home = path.join(ws, "home");
const privateEnv = path.join(home, ".grandpa-bob", ".env");
const projectEnv = path.join(root, ".env");

const none = (_p: string) => false;
const privateExists = (p: string) => p === privateEnv;

assert.equal(resolveEnvFile({ root, home, exists: none }), projectEnv, "fallback: project .env");
assert.equal(resolveEnvFile({ root, home, exists: privateExists }), privateEnv, "private env wins when present");
assert.equal(
  resolveEnvFile({ root, home, exists: privateExists, override: "custom.env" }),
  path.join(root, "custom.env"),
  "ENV_FILE override wins over everything",
);
assert.equal(
  resolveEnvFile({ root, home, exists: none, override: path.join(ws, "abs.env") }),
  path.join(ws, "abs.env"),
  "absolute ENV_FILE kept",
);

console.log("env-file: override > ~/.grandpa-bob/.env > project .env");
console.log("env-file-test: all assertions passed");
