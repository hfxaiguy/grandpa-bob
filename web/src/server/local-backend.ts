/**
 * In-browser implementation of the admin UI's /api surface.
 *
 * The shared UI (src/ui/pages.ts) was written against admin.ts's HTTP API. In
 * the browser target there is no server, so this maps those same requests onto
 * the AgentClient + Platform. Run it behind the fetch/EventSource shim
 * (./shim) so the exact Node UI runs unchanged.
 *
 * Endpoints with no browser equivalent (restart-bot, telegram, transcribe,
 * sync, log, env) return a 501 with a clear message; the UI degrades.
 */
import type { AgentClient } from "../agent/agent-client";
import type { Platform } from "../../../src/platform/types";
import { listAppTrees, listPatterns, listTreeSources } from "../../../src/tree-sources";
import { promoteDraft, resolveTreeEntry, scanTreeVersions } from "../../../src/tree-versions";
import { serializeTree } from "../../../src/tree-serialize";
import { newTurnApps, tagEventApp, type TurnApps } from "../../../src/app-attribution";
import { emitValue } from "../../../src/util/emit-text";
import { createModuleLoader } from "../agent/module-loader";
import { loadEnv, saveEnv, saveModelsJson } from "../settings";
import { applyDatabaseDumps, withSyncLock, writeDatabaseDumps } from "../../../src/db-sync";
import { transcribeBlob } from "../stt/browser-whisper";

export interface BackendResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

export interface BackendOptions {
  agent: AgentClient;
  platform: Platform;
  storage: "browser" | "desktop" | "direct";
  server: string;
  env: Record<string, string>;
  remote: string;
  initialPattern: string;
  /** Model registry JSON from browser settings (overrides the workspace models.json). */
  modelsJson?: string;
  /** Direct mode: the folder picked with the File System Access API. */
  rootHandle?: FileSystemDirectoryHandle;
  /** Direct mode: write SQL changes back to the real .db files. */
  sqlWriteBack?: boolean;
}

interface TurnRecord {
  turnId: string;
  input: string;
  inputApp?: string | null;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "done" | "error";
  error: string | null;
  output: string | null;
  emits: string[];
  levels: (string | null)[];
  emitApps: string[];
  awaiting: string | null;
  buttons: unknown[];
  events: { kind?: string; app?: string; content?: Record<string, unknown> }[];
}

type EventMessage = Record<string, unknown>;

export interface LocalBackend {
  ready: Promise<void>;
  request(method: string, pathname: string, search: URLSearchParams, body: string | FormData | null): Promise<BackendResponse>;
  subscribe(cb: (msg: EventMessage) => void): () => void;
}

const UNAVAILABLE = (what: string): BackendResponse => ({
  status: 501,
  body: { error: `${what} is not available in browser mode` },
});

export function createLocalBackend(opts: BackendOptions): LocalBackend {
  const { agent, platform } = opts;
  const sessionKey = "web:local";
  const turns: TurnRecord[] = [];
  const subscribers = new Set<(msg: EventMessage) => void>();
  let activePattern = opts.initialPattern || "trunk";
  let sessionLabel = "";
  let updatedAt = Date.now();
  let modelsJson = opts.modelsJson ?? "";
  const activeRefs = new Map<string, string>();

  const parseBody = <T>(b: string | FormData | null): T => {
    try {
      return JSON.parse(typeof b === "string" ? b : "{}") as T;
    } catch {
      return {} as T;
    }
  };

  // Browser secret store (localStorage; the Node target uses logs/secrets.db).
  const SECRETS_KEY = "bob:secrets";
  interface StoredSecret {
    contentType: string | null;
    base64: string;
    updatedAt: string;
  }
  const readSecrets = (): Record<string, StoredSecret> => {
    try {
      return JSON.parse(localStorage.getItem(SECRETS_KEY) || "{}") as Record<string, StoredSecret>;
    } catch {
      return {};
    }
  };
  const writeSecrets = (map: Record<string, StoredSecret>): void => {
    try {
      localStorage.setItem(SECRETS_KEY, JSON.stringify(map));
    } catch {
      /* quota/private mode */
    }
  };
  const base64Of = (bytes: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };

  const broadcast = (msg: EventMessage): void => {
    for (const cb of subscribers) {
      try {
        cb(msg);
      } catch {
        /* subscriber gone */
      }
    }
  };

  async function runTurn(turnId: string, text: string): Promise<void> {
    const record: TurnRecord = {
      turnId,
      input: text,
      inputApp: activeAwaiting() ?? "trunk",
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      error: null,
      output: null,
      emits: [],
      levels: [],
      emitApps: [],
      awaiting: null,
      buttons: [],
      events: [],
    };
    turns.push(record);
    if (turns.length > 20) turns.shift();
    updatedAt = Date.now();
    const apps = newTurnApps();
    broadcast({ type: "turn_start", turnId, session: sessionKey, input: text, inputApp: record.inputApp ?? "trunk", ts: record.startedAt, awaiting: null });
    try {
      const { result, emits } = await agent.run(
        {
          task: text,
          env: opts.env,
          pattern: activePattern,
          remote: opts.remote,
          storage: opts.storage,
          server: opts.server,
          modelsJson,
          rootHandle: opts.rootHandle,
          sqlWriteBack: opts.sqlWriteBack,
        },
        {
          onEvent: (event) => {
            const ev = event as { kind?: string; content?: Record<string, unknown>; scope_id?: number | null; branch_path?: string };
            const app = tagEventApp(apps, ev);
            trackMemory(app, ev);
            const tagged = { ...ev, app };
            record.events.push(tagged);
            broadcast({ type: "event", turnId, event: tagged });
          },
          onEmit: (value) => {
            const { text: t, buttons, level } = emitValue(value);
            const app = apps.current;
            if (t) {
              record.emits.push(t);
              record.levels.push(level ?? null);
              record.emitApps.push(app);
              record.output = record.output ? record.output + "\n\n" + t : t;
            }
            if (buttons?.length) record.buttons = buttons;
            broadcast({ type: "emit", turnId, text: t, buttons, level, app });
          },
        },
      );
      record.status = "done";
      const last = emits.length ? emits[emits.length - 1] : result;
      const lastText = emitValue(last).text;
      if (!record.output && lastText) record.output = lastText;
      // The browser agent does not report pause state, so assume the tree
      // paused (the norm): the suspended app, else trunk. Keeps the input box
      // available on the next turn.
      record.awaiting = apps.suspended ?? "trunk";
      record.endedAt = Date.now();
      broadcast({
        type: "turn_end", turnId, status: "done", error: null, output: record.output,
        buttons: record.buttons, emits: record.emits, levels: record.levels, emitApps: record.emitApps,
        awaiting: record.awaiting, ts: record.endedAt,
      });
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.endedAt = Date.now();
      broadcast({ type: "turn_end", turnId, status: "error", error: record.error, output: "", buttons: [], emits: [], awaiting: null, ts: record.endedAt });
    }
  }

  /** Memory writes, grouped by the app that made them (path -> value). */
  const memValues = new Map<string, Map<string, unknown>>();
  const memPaths = new Map<string, Map<string, Set<string>>>();
  function trackMemory(
    app: string,
    ev: { kind?: string; content?: { child?: unknown; value?: unknown; op?: unknown }; scope_id?: number | null; branch_path?: string },
  ): void {
    const c = ev.content;
    const memWrite = ev.kind === "memory" || (ev.kind === "record" && (c?.op === "memory" || c?.op === "memoryUpdate"));
    if (!memWrite || ev.scope_id == null) return;
    const child = typeof c?.child === "string" ? c.child : "";
    const slotKey = `${ev.scope_id}/${child}`;
    if (c && "value" in c) {
      let m = memValues.get(app);
      if (!m) { m = new Map(); memValues.set(app, m); }
      m.set(slotKey, c.value);
    }
    const nodePath = (ev.branch_path ?? "") + (child ? "/" + child : "");
    if (nodePath) {
      let pm = memPaths.get(app);
      if (!pm) { pm = new Map(); memPaths.set(app, pm); }
      let ps = pm.get(slotKey);
      if (!ps) { ps = new Set(); pm.set(slotKey, ps); }
      ps.add(nodePath);
    }
  }
  function memoryPayload(): { values: Record<string, unknown>; apps: Record<string, Record<string, unknown>> } {
    const values: Record<string, unknown> = {};
    const apps: Record<string, Record<string, unknown>> = {};
    for (const [app, slots] of memValues) {
      const pathMap = memPaths.get(app);
      if (!pathMap) continue;
      for (const [slotKey, v] of slots) {
        if (v === undefined) continue;
        for (const p of pathMap.get(slotKey) ?? []) {
          values[p] = v;
          (apps[app] ??= {})[p] = v;
        }
      }
    }
    return { values, apps };
  }
  function activeAwaiting(): string | null {
    return turns.length ? turns[turns.length - 1].awaiting : null;
  }

  async function patternCatalog(): Promise<BackendResponse> {
    try {
      const sources = await listTreeSources(platform.workspaceRoot);
      const patterns = sources.map((s) => ({ name: s.name, group: s.group, description: s.description, draft: s.draft }));
      const names = patterns.map((p) => p.name);
      const current = names.includes(activePattern) ? activePattern : names[0] ?? activePattern;
      activePattern = current;
      return { status: 200, body: { current, pattern: current, patterns, ref: "prod", refs: ["prod", "draft"] } };
    } catch {
      return { status: 200, body: { current: activePattern, pattern: activePattern, patterns: [], ref: "prod", refs: [] } };
    }
  }

  async function request(
    method: string,
    pathname: string,
    search: URLSearchParams,
    body: string | FormData | null,
  ): Promise<BackendResponse> {
    // ── chat ──────────────────────────────────────────────────────────────
    if (pathname === "/api/session" && method === "GET") {
      return {
        status: 200,
        body: {
          active: sessionKey,
          label: sessionLabel,
          follow: false,
          models: {},
          awaiting: activeAwaiting(),
          sessions: [{ key: sessionKey, label: sessionLabel || "local", pattern: activePattern, updatedAt, turns: turns.length, remote: false, awaiting: activeAwaiting() }],
          turns,
        },
      };
    }
    if (pathname === "/api/session" && method === "POST") {
      const parsed = parseBody(body) as { label?: string };
      if (typeof parsed.label === "string") sessionLabel = parsed.label.trim().slice(0, 80);
      return { status: 200, body: { ok: true, active: sessionKey, label: sessionLabel, turns } };
    }
    if (pathname === "/api/turns" && method === "GET") {
      return { status: 200, body: { turns, session: sessionKey, awaiting: activeAwaiting() } };
    }
    if (pathname === "/api/apps" && method === "GET") {
      const appTrees = await listAppTrees(platform.workspaceRoot).catch(() => []);
      return {
        status: 200,
        body: {
          apps: [
            { name: "trunk", description: "The main conversation tree.", group: "trunk" },
            ...appTrees.map((a) => ({ name: a.name, description: a.description, guide: a.guide, group: "app" })),
          ],
        },
      };
    }
    if (pathname === "/api/chat" && method === "POST") {
      const text = (parseBody(body) as { text?: string }).text ?? "";
      const turnId = crypto.randomUUID();
      void runTurn(turnId, text);
      return { status: 200, body: { turnId, queued: false } };
    }
    if (pathname === "/api/chat/upload" && method === "POST") {
      if (!(body instanceof FormData)) return { status: 400, body: { error: "multipart required" } };
      const file = body.get("file");
      if (!(file instanceof File)) return { status: 400, body: { error: "no file" } };
      const caption = String(body.get("caption") ?? "");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const safe = (file.name || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "upload";
      const rel = `assets/inbox/${crypto.randomUUID()}-${safe}`;
      const abs = platform.path.join(platform.workspaceRoot, rel);
      await platform.fs.mkdir(platform.path.dirname(abs), { recursive: true });
      await platform.fs.writeFile(abs, bytes);
      const text =
        `[Attached file: ${rel} (${file.type || "application/octet-stream"}, ${bytes.length} bytes)]` +
        (caption ? `\n\n${caption}` : "");
      const turnId = crypto.randomUUID();
      void runTurn(turnId, text);
      return { status: 200, body: { ok: true, turnId } };
    }
    if (pathname === "/api/clear" && method === "POST") {
      turns.length = 0;
      broadcast({ type: "cleared" });
      return { status: 200, body: { ok: true } };
    }
    if (pathname === "/api/status" && method === "GET") {
      return {
        status: 200,
        body: {
          telegram: "n/a",
          voice: "browser whisper (local)",
          llm: "n/a",
          uptime: Math.round(performance.now() / 1000),
          pid: null,
          workspace: platform.workspaceRoot,
          storage: opts.storage,
        },
      };
    }
    // ── pattern / tree ────────────────────────────────────────────────────
    if (pathname === "/api/pattern" && method === "GET") return patternCatalog();
    if (pathname === "/api/pattern" && method === "POST") {
      const want = (parseBody(body) as { name?: string }).name;
      if (want) activePattern = want;
      return { status: 200, body: { pattern: activePattern } };
    }
    if (pathname === "/api/tree/memory") return { status: 200, body: memoryPayload() };
    if (pathname === "/api/models/slots" && method === "GET") {
      let slots: { name: string; model: string; baseURL: string }[] = [];
      try {
        const reg = JSON.parse(modelsJson || "{}") as Record<string, { model?: string; baseURL?: string }>;
        slots = Object.entries(reg).map(([name, v]) => ({ name, model: v?.model ?? "", baseURL: v?.baseURL ?? "" }));
      } catch {
        /* malformed registry — no slots */
      }
      return { status: 200, body: { slots, active: sessionKey, models: {} } };
    }
    if (pathname === "/api/chat/model" && method === "POST") {
      // Per-session model overrides are a Node-target feature; accept and no-op.
      return { status: 200, body: { ok: true, models: {} } };
    }
    if (pathname === "/api/tree/versions" && method === "GET") {
      const name = search.get("name") ?? "";
      const catalog = (await scanTreeVersions(platform.workspaceRoot).catch(() => [])).find((c) => c.logical === name);
      return {
        status: 200,
        body: {
          versions: catalog?.versions ?? [],
          prod: catalog?.prodVersion ?? null,
          draft: catalog?.draft ?? false,
          active: activeRefs.get(name) ?? "prod",
        },
      };
    }
    if (pathname === "/api/tree/version/promote" && method === "POST") {
      const { name = "" } = parseBody(body) as { name?: string };
      return { status: 200, body: await promoteDraft(platform.workspaceRoot, name) };
    }
    if (pathname === "/api/tree/version/active" && method === "POST") {
      const { name = "", ref = "prod" } = parseBody(body) as { name?: string; ref?: string };
      if (name) activeRefs.set(name, ref || "prod");
      return { status: 200, body: { ok: true, active: ref || "prod" } };
    }
    if (pathname === "/api/tree/spec" && method === "GET") {
      const spec = search.get("pattern") ?? "";
      const at = spec.lastIndexOf("@");
      const entry = await resolveTreeEntry(
        platform.workspaceRoot,
        at >= 0 ? spec.slice(0, at) : spec,
        at >= 0 ? spec.slice(at + 1) : "prod",
      );
      if (!entry?.specAbs) return { status: 404, body: { error: "no spec for this version" } };
      const text = await platform.fs.readFile(entry.specAbs, "utf8").catch(() => null);
      if (text == null) return { status: 404, body: { error: "no spec for this version" } };
      return { status: 200, body: { specFile: entry.specFile, spec: text } };
    }
    if (pathname === "/api/tree" && method === "GET") {
      const spec = search.get("pattern") ?? "";
      const at = spec.lastIndexOf("@");
      const logical = at >= 0 ? spec.slice(0, at) : spec;
      const entry = await resolveTreeEntry(platform.workspaceRoot, logical, at >= 0 ? spec.slice(at + 1) : "prod");
      if (!entry) return { status: 404, body: { error: `tree not found: ${logical}` } };
      try {
        const mod = await createModuleLoader(platform).load(entry.file);
        const def = (mod as { default?: unknown }).default ?? mod;
        return { status: 200, body: { pattern: entry.internalName, tree: serializeTree(def) } };
      } catch (err) {
        return { status: 500, body: { error: `could not load tree: ${err instanceof Error ? err.message : String(err)}` } };
      }
    }
    // ── files ─────────────────────────────────────────────────────────────
    if (pathname === "/api/files" && method === "GET") {
      const rel = search.get("path") ?? ".";
      try {
        const dirAbs = platform.path.resolve(platform.workspaceRoot, rel);
        const entries = await platform.fs.readdir(dirAbs, { withFileTypes: true });
        const files = entries
          .map((e) => ({ name: e.name, isDir: e.isDirectory(), size: 0, mtime: null as number | null }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        return { status: 200, body: { dir: rel === "." ? "" : rel, files } };
      } catch {
        return { status: 200, body: { dir: rel, files: [] } };
      }
    }
    if (pathname === "/api/files" && method === "DELETE") {
      const rel = search.get("path") ?? "";
      try {
        await platform.fs.rm(platform.path.resolve(platform.workspaceRoot, rel));
        return { status: 200, body: { ok: true } };
      } catch (err) {
        return { status: 400, body: { error: String(err) } };
      }
    }
    if (pathname === "/api/files/download") {
      const rel = search.get("path") ?? "";
      try {
        const content = await platform.fs.readFile(platform.path.resolve(platform.workspaceRoot, rel), "utf8");
        return { status: 200, contentType: "text/plain; charset=utf-8", body: content };
      } catch (err) {
        return { status: 404, body: { error: String(err) } };
      }
    }

    // ── voice (browser-local whisper) ─────────────────────────────────────
    if (pathname === "/api/transcribe" && method === "POST") {
      if (!(body instanceof FormData)) return { status: 400, body: { error: "multipart required" } };
      const file = body.get("file");
      if (!(file instanceof Blob) || file.size === 0) {
        return { status: 400, body: { error: "no audio file" } };
      }
      try {
        const text = await transcribeBlob(file);
        return { status: 200, body: { text } };
      } catch (err) {
        return {
          status: 502,
          body: { error: `transcription failed: ${err instanceof Error ? err.message : String(err)}` },
        };
      }
    }

    if (pathname === "/api/files/upload" && method === "POST") {
      if (!(body instanceof FormData)) return { status: 400, body: { error: "multipart required" } };
      const dir = String(body.get("path") ?? "");
      const file = body.get("file");
      if (!(file instanceof File)) return { status: 400, body: { error: "no file" } };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const target = platform.path.join(platform.workspaceRoot, dir, file.name);
      await platform.fs.mkdir(platform.path.dirname(target), { recursive: true });
      await platform.fs.writeFile(target, bytes);
      return { status: 200, body: { ok: true, name: file.name } };
    }

    // ── patterns ──────────────────────────────────────────────────────────
    if (pathname === "/api/patterns" && method === "GET") {
      const patterns = await listPatterns(platform.workspaceRoot).catch(() => []);
      return { status: 200, body: { patterns } };
    }
    if (pathname.startsWith("/api/patterns/") && method === "GET") {
      const name = decodeURIComponent(pathname.slice("/api/patterns/".length));
      try {
        const content = await platform.fs.readFile(platform.path.join(platform.workspaceRoot, "patterns", `${name}.mjs`), "utf8");
        return { status: 200, body: { name, content } };
      } catch {
        return { status: 404, body: { error: "not found" } };
      }
    }
    if (pathname === "/api/patterns" && method === "POST") {
      const parsed = parseBody(body) as { name?: string; content?: string };
      if (!parsed.name || typeof parsed.content !== "string") {
        return { status: 400, body: { error: "name and content required" } };
      }
      const file = platform.path.join(platform.workspaceRoot, "patterns", `${parsed.name.replace(/\.mjs$/, "")}.mjs`);
      await platform.fs.mkdir(platform.path.dirname(file), { recursive: true });
      await platform.fs.writeFile(file, parsed.content);
      return { status: 200, body: { ok: true, name: parsed.name } };
    }
    if (pathname.startsWith("/api/patterns/") && method === "DELETE") {
      const name = decodeURIComponent(pathname.slice("/api/patterns/".length));
      try {
        await platform.fs.rm(platform.path.join(platform.workspaceRoot, "patterns", `${name}.mjs`));
        return { status: 200, body: { ok: true } };
      } catch (err) {
        return { status: 404, body: { error: String(err) } };
      }
    }

    // ── models (browser settings; keys never touch the workspace) ─────────
    if (pathname === "/api/models" && method === "GET") {
      return { status: 200, body: { json: modelsJson } };
    }
    if (pathname === "/api/models" && method === "POST") {
      const json = parseBody<{ json?: string }>(body).json ?? "";
      modelsJson = json;
      saveModelsJson(json);
      return { status: 200, body: { ok: true } };
    }

    // ── env (browser settings) ────────────────────────────────────────────
    if (pathname === "/api/env" && method === "POST") {
      const vars = parseBody(body) as Record<string, string>;
      const env = loadEnv();
      for (const [k, v] of Object.entries(vars)) if (v) env[k] = String(v);
      saveEnv(env);
      return { status: 200, body: { ok: true } };
    }

    // ── git (commit/sync) over the active platform ────────────────────────
    if (pathname === "/api/commit" && method === "POST") {
      const message = (parseBody<{ message?: string }>(body).message || "").trim() || "manual commit from admin UI";
      try {
        await platform.git.ensureRepo();
        await writeDatabaseDumps(platform).catch(() => {});
        const hash = platform.git.commitAll
          ? await platform.git.commitAll(message)
          : await platform.git.autoCommit(["."], message);
        return { status: 200, body: { ok: true, committed: hash !== "no-changes", hash } };
      } catch (err) {
        return { status: 200, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }
    if ((pathname === "/api/sync/push" || pathname === "/api/sync/pull") && method === "POST") {
      const p = parseBody<{ local?: string; remote?: string }>(body);
      const posted = p.remote ?? "";
      const url = opts.remote || (/[:\/]/.test(posted) ? posted : "");
      if (!url) return { status: 400, body: { error: "set a git remote first" } };
      const branch = posted || p.local || "master";
      try {
        if (pathname === "/api/sync/pull") {
          const out = platform.git.pull
            ? await platform.git.pull(url, branch)
            : await platform.git.fetch?.(url);
          const dbSync = await applyDatabaseDumps(platform).catch(() => null);
          return { status: 200, body: { ok: true, output: typeof out === "string" ? out : JSON.stringify(out ?? {}), dbSync } };
        }
        const out = await withSyncLock(platform, { remote: url }, async () => {
          await writeDatabaseDumps(platform).catch(() => {});
          await platform.git.commitAll?.("sync: database dumps").catch(() => {});
          return platform.git.push?.(url, branch);
        });
        return { status: 200, body: { ok: true, output: typeof out === "string" ? out : JSON.stringify(out ?? {}) } };
      } catch (err) {
        return { status: 200, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    // ── logs ──────────────────────────────────────────────────────────────
    if (pathname === "/api/log") return { status: 200, body: { content: "" } };

    // ── secrets (declarations in app/*/secrets.json; stored in localStorage) ─
    if (pathname === "/api/secrets" && method === "GET") {
      const stored = readSecrets();
      const secrets: unknown[] = [];
      try {
        const appDir = platform.path.join(platform.workspaceRoot, "app");
        const apps = await platform.fs.readdir(appDir, { withFileTypes: true });
        for (const appEntry of apps) {
          if (!appEntry.isDirectory()) continue;
          try {
            const raw = JSON.parse(
              await platform.fs.readFile(platform.path.join(appDir, appEntry.name, "secrets.json"), "utf8"),
            ) as unknown;
            const list = Array.isArray(raw)
              ? raw
              : Array.isArray((raw as { secrets?: unknown[] })?.secrets)
                ? (raw as { secrets: unknown[] }).secrets
                : [];
            for (const item of list) {
              const it = item as { name?: unknown; description?: unknown; contentType?: unknown };
              if (typeof it?.name !== "string") continue;
              const hit = stored[`${appEntry.name}/${it.name}`];
              secrets.push({
                app: appEntry.name,
                name: it.name,
                description: typeof it.description === "string" ? it.description : "",
                contentType: typeof it.contentType === "string" ? it.contentType : null,
                present: !!hit,
                size: hit ? Math.floor((hit.base64.length * 3) / 4) : 0,
                updatedAt: hit?.updatedAt ?? null,
              });
            }
          } catch {
            /* no manifest */
          }
        }
      } catch {
        /* no app dir */
      }
      return { status: 200, body: { secrets } };
    }
    if (pathname === "/api/secrets" && method === "POST") {
      if (!(body instanceof FormData)) return { status: 400, body: { error: "multipart required" } };
      const appName = search.get("app") ?? "";
      const secretName = search.get("name") ?? "";
      const file = body.get("file");
      if (!(file instanceof File)) return { status: 400, body: { error: "no file" } };
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > 1024 * 1024) return { status: 413, body: { error: "secret too large (max 1 MB)" } };
      const map = readSecrets();
      map[`${appName}/${secretName}`] = {
        contentType: file.type || "application/octet-stream",
        base64: base64Of(bytes),
        updatedAt: new Date().toISOString(),
      };
      writeSecrets(map);
      return { status: 200, body: { ok: true, app: appName, name: secretName, size: bytes.length } };
    }
    if (pathname === "/api/secrets/vars" && method === "POST") {
      const appName = search.get("app") ?? "";
      const secretName = search.get("name") ?? "";
      const value = parseBody<{ value?: unknown }>(body).value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { status: 400, body: { error: "value must be an object" } };
      }
      const text = JSON.stringify(value, null, 2);
      const map = readSecrets();
      map[`${appName}/${secretName}`] = {
        contentType: "application/json",
        base64: base64Of(new TextEncoder().encode(text)),
        updatedAt: new Date().toISOString(),
      };
      writeSecrets(map);
      return { status: 200, body: { ok: true, app: appName, name: secretName, size: text.length } };
    }
    // Import a desktop secrets.db (app_secrets table) into the localStorage
    // store. Body: { base64 }. The uploaded DB is written to a temp OPFS path
    // (not *.db, so the auto-sync dumper ignores it), read, then removed.
    if (pathname === "/api/secrets/import" && method === "POST") {
      const b64 = parseBody<{ base64?: string }>(body).base64 ?? "";
      if (!b64) return { status: 400, body: { error: "base64 required" } };
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const tmpAbs = platform.path.join(platform.workspaceRoot, ".secrets-import.tmp");
      try {
        await platform.fs.writeFile(tmpAbs, bytes);
        const db = await platform.sqlite.open(tmpAbs, { readOnly: true });
        let imported = 0;
        try {
          const stmt = await db.prepare("SELECT app, name, content, content_type, updated_at FROM app_secrets");
          const rows = (await stmt.all()) as Array<Record<string, unknown>>;
          const map = readSecrets();
          for (const row of rows) {
            const app = String(row.app ?? "");
            const name = String(row.name ?? "");
            if (!app || !name) continue;
            const raw = row.content;
            const bytesOf =
              raw instanceof Uint8Array
                ? raw
                : raw instanceof ArrayBuffer
                  ? new Uint8Array(raw)
                  : Array.isArray(raw)
                    ? Uint8Array.from(raw as number[])
                    : typeof raw === "string"
                      ? new TextEncoder().encode(raw)
                      : new Uint8Array();
            map[`${app}/${name}`] = {
              contentType: row.content_type == null ? null : String(row.content_type),
              base64: base64Of(bytesOf),
              updatedAt: row.updated_at == null ? new Date().toISOString() : String(row.updated_at),
            };
            imported++;
          }
          writeSecrets(map);
        } finally {
          await db.close();
        }
        return { status: 200, body: { ok: true, imported } };
      } catch (err) {
        return { status: 200, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      } finally {
        await platform.fs.rm(tmpAbs).catch(() => {});
      }
    }
    if (pathname === "/api/secrets" && method === "DELETE") {
      const appName = search.get("app") ?? "";
      const secretName = search.get("name") ?? "";
      const map = readSecrets();
      const key = `${appName}/${secretName}`;
      const existed = !!map[key];
      delete map[key];
      writeSecrets(map);
      return { status: existed ? 200 : 404, body: { ok: existed } };
    }

    if (pathname.startsWith("/api/")) return UNAVAILABLE(pathname);
    return { status: 404, body: { error: "not found" } };
  }

  const ready = Promise.resolve();

  return {
    ready,
    request,
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
  };
}
