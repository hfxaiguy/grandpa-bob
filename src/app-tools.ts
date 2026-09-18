import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface AppTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/**
 * Discover app tools from workspace/app/<name>/tools.mjs (or tools.js).
 * An app with a broken or invalid tool module is skipped so one optional app
 * cannot prevent BOB from starting.
 */
export async function loadAppTools(workspace: string): Promise<AppTool[]> {
  const appsDir = path.join(workspace, "app");
  const entries = await fs.readdir(appsDir, { withFileTypes: true }).catch(() => []);
  const tools: AppTool[] = [];
  const names = new Set<string>();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const appDir = path.join(appsDir, entry.name);
    const modulePath = await firstExisting([
      path.join(appDir, "tools.mjs"),
      path.join(appDir, "tools.js"),
    ]);
    if (!modulePath) continue;

    try {
      const mod = await import(pathToFileURL(modulePath).href);
      if (!Array.isArray(mod.tools)) throw new Error("must export an array named tools");
      for (const tool of mod.tools as unknown[]) {
        validateTool(tool, entry.name);
        const appTool = tool as AppTool;
        if (names.has(appTool.name)) throw new Error(`duplicate tool name: ${appTool.name}`);
        names.add(appTool.name);
        tools.push(appTool);
      }
    } catch (error) {
      console.warn(`[app-tools] skipped ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return tools;
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return undefined;
}

function validateTool(value: unknown, appName: string): asserts value is AppTool {
  if (!value || typeof value !== "object") throw new Error(`${appName} tool is not an object`);
  const tool = value as Partial<AppTool>;
  if (!tool.name || typeof tool.name !== "string") throw new Error(`${appName} tool has no name`);
  if (typeof tool.execute !== "function") throw new Error(`${appName}/${tool.name} has no execute function`);
}
