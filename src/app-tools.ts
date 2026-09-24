import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validSecretName, type SecretsStore } from "./secrets.js";

/**
 * Per-app runtime context handed to every tool's execute(args, ctx).
 * Existing tools ignore the second argument; apps that asked for secret
 * config files (app/<name>/secrets.json) read ONLY their own:
 *
 *   execute: (args, ctx) => {
 *     const creds = ctx.requireSecret("google-service-account.json");
 *     ...
 *   }
 */
export interface AppToolContext {
  /** The app directory name (e.g. "calendar"). */
  app: string;
  /** Raw bytes of a stored secret, or null when not uploaded yet. */
  secret(name: string): Buffer | null;
  /** UTF-8 text of a stored secret, or null. */
  secretText(name: string): string | null;
  /**
   * Like secretText, but throws a user-actionable error when the secret
   * is missing — the message points at the WebUI upload page, so the
   * model (or a tree) can tell the user exactly what to do.
   */
  requireSecret(name: string): string;
  /** Names + timestamps of this app's uploaded secrets (no content). */
  listSecrets(): { name: string; updatedAt: string; size: number }[];
}

export interface AppTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx?: AppToolContext) => unknown | Promise<unknown>;
  /** Set by the loader: owning app directory + its secret context. */
  app?: string;
  appContext?: AppToolContext;
}

/**
 * Discover app tools from workspace/app/<name>/tools.mjs (or tools.js).
 * An app with a broken or invalid tool module is skipped so one optional app
 * cannot prevent BOB from starting.
 */
export async function loadAppTools(workspace: string, secrets?: SecretsStore): Promise<AppTool[]> {
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

    const ctx: AppToolContext = {
      app: entry.name,
      secret: (name) => (validSecretName(name) ? secrets?.get(entry.name, name)?.content ?? null : null),
      secretText: (name) => ctx.secret(name)?.toString("utf8") ?? null,
      requireSecret: (name) => {
        const bytes = ctx.secret(name);
        if (bytes === null) {
          const how = secrets
            ? "upload it in the WebUI: settings page → App secrets"
            : "the secrets store is not available in this process";
          throw new Error(`secret "${name}" for app "${entry.name}" is missing — ${how}`);
        }
        return bytes.toString("utf8");
      },
      listSecrets: () =>
        (secrets?.list(entry.name) ?? []).map((s) => ({ name: s.name, updatedAt: s.updatedAt, size: s.size })),
    };

    try {
      const mod = await import(pathToFileURL(modulePath).href);
      if (!Array.isArray(mod.tools)) throw new Error("must export an array named tools");
      for (const tool of mod.tools as unknown[]) {
        validateTool(tool, entry.name);
        const appTool = tool as AppTool;
        if (names.has(appTool.name)) throw new Error(`duplicate tool name: ${appTool.name}`);
        names.add(appTool.name);
        appTool.app = entry.name;
        appTool.appContext = ctx;
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
