// Node model-registry loader. Reads `models.json` from the working directory
// and hands the text to the pure parser in model-config.ts (shared with the
// browser target). Throws if the file is absent.

import fs from "node:fs/promises";
import path from "node:path";
import { parseModels, type ModelRegistry } from "./model-config.js";

export type { ModelTransform, ModelEntry, ModelRegistry, EnvMap } from "./model-config.js";
export { parseModels, BUILTIN_TRANSFORMS } from "./model-config.js";

export async function loadModels(cwd = process.cwd()): Promise<ModelRegistry> {
  const file = path.resolve(cwd, "models.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(
      "models.json not found. Copy models.example.json to models.json and edit it. " +
        "Secrets can use ${ENV_VAR} interpolation (e.g. ${OLLAMA_API_KEY}).",
    );
  }
  return parseModels(raw, process.env);
}
