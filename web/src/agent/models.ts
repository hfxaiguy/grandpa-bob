/**
 * Load the model registry from the OPFS workspace's `models.json`, interpolating
 * `${ENV}` against browser settings. Reuses the shared pure parser.
 */
import { parseModels, type ModelRegistry } from "../../../src/model-config";
import type { Platform } from "../../../src/platform/types";

export async function loadBrowserModels(
  platform: Platform,
  env: Record<string, string> = {},
): Promise<ModelRegistry> {
  const file = platform.path.join(platform.workspaceRoot, "models.json");
  try {
    const raw = await platform.fs.readFile(file, "utf8");
    return parseModels(raw, env);
  } catch {
    return {};
  }
}
