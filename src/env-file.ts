// Which .env the bot loads and the admin edits.
//
// Credentials should not depend on a .gitignore line inside the project
// checkout, so a private per-user file wins when present:
//
//   1. ENV_FILE=<path>            explicit override (relative to project root)
//   2. ~/.grandpa-bob/.env        private config dir (0700 family)
//   3. <projectDir>/.env          historical location, still the fallback
//
// Moving an existing install is a plain `mv .env ~/.grandpa-bob/.env`.

import fs from "node:fs";
import path from "node:path";

export interface EnvFileOptions {
  root: string;
  home: string;
  override?: string;
  /** Injectable for tests. */
  exists?: (p: string) => boolean;
}

export function resolveEnvFile({ root, home, override, exists = fs.existsSync }: EnvFileOptions): string {
  if (override && override.trim()) return path.resolve(root, override.trim());
  const privateEnv = path.join(home, ".grandpa-bob", ".env");
  if (exists(privateEnv)) return privateEnv;
  return path.join(root, ".env");
}
