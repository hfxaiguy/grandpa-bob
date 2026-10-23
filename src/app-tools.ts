import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LOGICAL_SEGMENT_RE } from "./tree-files.js";
import { validSecretName, type SecretsStore } from "./secrets.js";

/**
 * Per-app runtime context handed to every tool's execute(args, ctx).
 * Existing tools ignore the second argument; apps that asked for secret
 * config files (app/<name>/secrets.json — nested apps their dotted path)
 * read ONLY their own:
 *
 *   execute: (args, ctx) => {
 *     const creds = ctx.requireSecret("google-service-account.json");
 *     ...
 *   }
 */
export interface AppToolContext {
  /** The app's logical name — a top-level folder name, or dotted for a
   *  nested app (`contacts.organizer`). */
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
  /**
   * Optional prompt guidance for the agent ("how to use this app well").
   * Declared as a module-level `export const guide = "…"` in tools.mjs (a
   * per-tool `guide` field wins). Never sent in the tool schema.
   */
  guide?: string;
}

/**
 * Discover app tools from workspace/app/<name>/tools.mjs (or tools.js), at any
 * depth — an app folder may keep an `app/` folder of its own, and each
 * discovered app is keyed by its dotted logical name (`a.b`). An app with a
 * broken or invalid tool module is skipped so one optional app cannot prevent
 * BOB from starting.
 */
export async function loadAppTools(workspace: string, secrets?: SecretsStore): Promise<AppTool[]> {
  const tools: AppTool[] = [];
  const names = new Set<string>();
  await collectAppTools(path.join(workspace, "app"), "", secrets, tools, names);
  return tools;
}

/** One app folder: its own tools.mjs, then its `app/` children, depth first. */
async function collectAppTools(
  dirAbs: string,
  logical: string,
  secrets: SecretsStore | undefined,
  tools: AppTool[],
  names: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // no such folder
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || !LOGICAL_SEGMENT_RE.test(entry.name)) continue;
    const childLogical = logical ? `${logical}.${entry.name}` : entry.name;
    const appDir = path.join(dirAbs, entry.name);

    const modulePath = await firstExisting([
      path.join(appDir, "tools.mjs"),
      path.join(appDir, "tools.js"),
    ]);
    if (modulePath) {
      const ctx: AppToolContext = {
        app: childLogical,
        secret: (name) => (validSecretName(name) ? secrets?.get(childLogical, name)?.content ?? null : null),
        secretText: (name) => ctx.secret(name)?.toString("utf8") ?? null,
        requireSecret: (name) => {
          const bytes = ctx.secret(name);
          if (bytes === null) {
            const how = secrets
              ? "upload it in the WebUI: settings page → App secrets"
              : "the secrets store is not available in this process";
            throw new Error(`secret "${name}" for app "${childLogical}" is missing — ${how}`);
          }
          return bytes.toString("utf8");
        },
        listSecrets: () =>
          (secrets?.list(childLogical) ?? []).map((s) => ({ name: s.name, updatedAt: s.updatedAt, size: s.size })),
      };

      try {
        const mod = await import(pathToFileURL(modulePath).href);
        if (mod.ready && typeof mod.ready.then === "function") {
          await mod.ready;
        }
        if (!Array.isArray(mod.tools)) throw new Error("must export an array named tools");
        for (const tool of mod.tools as unknown[]) {
          validateTool(tool, childLogical);
          const appTool = tool as AppTool;
          if (names.has(appTool.name)) throw new Error(`duplicate tool name: ${appTool.name}`);
          names.add(appTool.name);
          appTool.app = childLogical;
          appTool.appContext = ctx;
          if (!appTool.guide && typeof mod.guide === "string" && mod.guide.trim()) {
            appTool.guide = mod.guide.trim();
          }
          tools.push(appTool);
        }
      } catch (error) {
        console.warn(`[app-tools] skipped ${childLogical}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The fractal descent happens even for tools-only apps: a folder without
    // tools.mjs may still host sub-apps.
    await collectAppTools(path.join(appDir, "app"), childLogical, secrets, tools, names);
  }
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
