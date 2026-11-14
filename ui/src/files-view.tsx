/**
 * Workspace Files view — the Solid replacement for the old server-rendered
 * Files page. Same `/api/*` contracts, no iframe.
 */
import { For, Show, createSignal, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { getJSON, postForm, postJSON } from "./api";
import { toast } from "./store";
import logoMark from "./assets/logo-mark.webp";
import { buildInfo } from "./build-info";

interface FileEntry {
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: number | null;
}

interface PatternInfo {
  name: string;
  file?: string;
  description?: string;
}

interface SecretInfo {
  app: string;
  name: string;
  description?: string;
  contentType?: string | null;
  present: boolean;
  size?: number;
  updatedAt?: string | null;
  fields?: Record<string, string>;
}

interface SyncResponse {
  ok?: boolean;
  committed?: boolean;
  hash?: string;
  output?: string;
  error?: string;
}

const NEW_PATTERN_TEMPLATE = `// my-pattern.prod.mjs — description of what this pattern does
//
// The function receives the Tree element surface as arguments.
// Available: { Tree, name, Model, Tools, Human, Prompt, Memory, Emit, Return, Until, when, max, flag }
//
// Must return a Tree definition — the result of Tree(element, ...).
//
// Memory slots available in prompt functions (m):
//   m.system      — the system prompt string
//   m.messages    — conversation history array [{role, content}, ...]
//   m.main_input  — the current user message
//   m.branch.X    — exported value of branch X
//   m.prev[i]     — most-recent-first sibling outputs
//   m.raw.prev[i] — full record: { content, reasoning, toolCalls, toolResults }
//   m.error       — feedback from last failed check

export default function({ Tree, name, Human, Prompt, Emit, Until, max, flag }) {
  return Tree(
    name("my-pattern"),
    Human("main_input"),
    Prompt((m) => "You said: " + m.main_input + ". Respond briefly."),
    Emit((m) => m.prev[0]),
    Until(() => false, max(100000)),
  );
}
`;

function deleteRequest(path: string): Promise<unknown> {
  return fetch(path, { method: "DELETE" }).then(async (r) => {
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new Error(data.error || `DELETE ${path}: ${r.status}`);
    return data;
  });
}

function formatSize(bytes: number | undefined): string {
  const n = bytes ?? 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function parentPath(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function validFieldKey(key: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(key) && !key.startsWith(".") && !key.endsWith(".") && !key.includes("..");
}

function SecretCard(props: { secret: SecretInfo; onChanged: () => void }) {
  let pick: HTMLInputElement | undefined;
  const initialRows = () => {
    const fields = props.secret.fields ?? {};
    const keys = Object.keys(fields);
    return keys.length
      ? keys.map((key) => ({ key, value: "", hint: fields[key] || "" }))
      : [{ key: "", value: "", hint: "" }];
  };
  const [rows, setRows] = createStore<{ items: { key: string; value: string; hint: string }[] }>({
    items: initialRows(),
  });
  const isJson = () =>
    String(props.secret.contentType || "").toLowerCase().includes("json") ||
    !!(props.secret.fields && Object.keys(props.secret.fields).length);
  const statusColor = () => (props.secret.present ? "var(--ok)" : "var(--err)");
  const statusText = () => {
    if (props.secret.present) {
      const when = props.secret.updatedAt ? new Date(props.secret.updatedAt).toLocaleString() : "";
      return `✓ ${when}${when ? " · " : ""}${formatSize(props.secret.size)}`;
    }
    return isJson() ? "missing — enter the values below" : "missing — upload it below";
  };

  function addRow(): void {
    setRows("items", (items) => [...items, { key: "", value: "", hint: "" }]);
  }

  function removeRow(index: number): void {
    setRows("items", (items) => items.filter((_, i) => i !== index));
  }

  async function saveField(key: string, value: string): Promise<void> {
    if (!key) {
      toast("enter a key first", true);
      return;
    }
    if (!validFieldKey(key)) {
      toast(`invalid key: ${key}`, true);
      return;
    }
    if (value === "") {
      toast("enter a value (delete the secret to remove it)", true);
      return;
    }
    try {
      await postJSON(
        `/api/secrets/vars?app=${encodeURIComponent(props.secret.app)}&name=${encodeURIComponent(props.secret.name)}`,
        { key, value },
      );
      toast(`saved ${key} for ${props.secret.name}`);
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "save failed", true);
    }
  }

  async function saveAll(): Promise<void> {
    const set: Record<string, string> = {};
    let bad = "";
    for (const row of rows.items) {
      const key = row.key.trim();
      const value = row.value;
      if (!key) continue;
      if (!validFieldKey(key)) {
        bad = key;
        continue;
      }
      if (value === "") continue;
      set[key] = value;
    }
    if (bad) {
      toast(`invalid key: ${bad}`, true);
      return;
    }
    if (!Object.keys(set).length) {
      toast("enter at least one value", true);
      return;
    }
    try {
      await postJSON(
        `/api/secrets/vars?app=${encodeURIComponent(props.secret.app)}&name=${encodeURIComponent(props.secret.name)}`,
        { set },
      );
      toast(`saved vars for ${props.secret.app}/${props.secret.name}`);
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "save failed", true);
    }
  }

  async function uploadSecret(): Promise<void> {
    const file = pick?.files?.[0];
    if (!file) {
      toast("pick a file first", true);
      return;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      await postForm(
        `/api/secrets?app=${encodeURIComponent(props.secret.app)}&name=${encodeURIComponent(props.secret.name)}`,
        form,
      );
      toast(`stored ${props.secret.app}/${props.secret.name}`);
      if (pick) pick.value = "";
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "upload failed", true);
    }
  }

  async function removeSecret(): Promise<void> {
    if (!confirm(`Delete stored secret ${props.secret.app}/${props.secret.name}?`)) return;
    try {
      await deleteRequest(
        `/api/secrets?app=${encodeURIComponent(props.secret.app)}&name=${encodeURIComponent(props.secret.name)}`,
      );
      toast(`deleted ${props.secret.name}`);
      props.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "delete failed", true);
    }
  }

  return (
    <div class="secret-row">
      <div class="secret-info">
        <div>
          <b>{props.secret.app}</b> / {props.secret.name}{" "}
          <Show when={props.secret.description}>
            <small class="muted">{props.secret.description}</small>
          </Show>
        </div>
        <small style={{ color: statusColor() }}>{statusText()}</small>
      </div>

      <Show
        when={isJson()}
        fallback={
          <>
            <div class="secret-upload">
              <input
                ref={(el) => (pick = el)}
                type="file"
                onChange={() => {
                  /* the upload button reads the picker */
                }}
              />
              <button class="secondary" type="button" onClick={() => void uploadSecret()}>
                {props.secret.present ? "replace" : "upload"}
              </button>
            </div>
          </>
        }
      >
        <div class="secret-editor">
          <For each={rows.items}>
            {(row, index) => (
              <div class="secret-var">
                <input
                  type="text"
                  placeholder="key (e.g. auth.token)"
                  value={row.key}
                  onInput={(e) => setRows("items", index(), "key", e.currentTarget.value)}
                />
                <input
                  type="text"
                  placeholder={row.hint || "value"}
                  value={row.value}
                  onInput={(e) => setRows("items", index(), "value", e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveField(rows.items[index()].key.trim(), rows.items[index()].value);
                    }
                  }}
                />
                <button
                  class="secondary"
                  type="button"
                  title="save just this field; the others are left alone"
                  onClick={() => void saveField(row.key.trim(), row.value)}
                >
                  save
                </button>
                <button class="secondary" type="button" onClick={() => removeRow(index())}>
                  ×
                </button>
              </div>
            )}
          </For>
          <div class="secret-actions">
            <button class="secondary" type="button" onClick={addRow}>
              + add var
            </button>
            <button
              type="button"
              title="save every filled field; the fields you leave blank are not touched"
              onClick={() => void saveAll()}
            >
              Save all
            </button>
          </div>
          <details>
            <summary>or upload a file instead</summary>
            <div class="secret-upload">
              <input
                ref={(el) => (pick = el)}
                type="file"
                onChange={() => {
                  /* the upload button reads the picker */
                }}
              />
              <button class="secondary" type="button" onClick={() => void uploadSecret()}>
                {props.secret.present ? "replace" : "upload"}
              </button>
            </div>
          </details>
        </div>
      </Show>

      <Show when={props.secret.present}>
        <button class="secondary" type="button" onClick={() => void removeSecret()}>
          delete
        </button>
      </Show>
    </div>
  );
}

export function FilesView(props: { onChat: () => void; onSettings: () => void }) {
  // ── files ────────────────────────────────────────────────────────────
  const [dir, setDir] = createSignal("");
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  let uploadInput: HTMLInputElement | undefined;

  async function browse(path?: string): Promise<void> {
    const target = path === undefined ? dir() : path;
    setDir(target);
    try {
      const d = await getJSON<{ dir?: string; files?: FileEntry[] }>(
        `/api/files?path=${encodeURIComponent(target)}`,
      );
      setDir(d.dir ?? target);
      setFiles(d.files ?? []);
    } catch (e) {
      setFiles([]);
      toast(e instanceof Error ? e.message : "could not list files", true);
    }
  }

  async function uploadFiles(list: FileList | null): Promise<void> {
    if (!list || !list.length) return;
    for (const file of Array.from(list)) {
      const form = new FormData();
      form.append("path", dir());
      form.append("file", file);
      try {
        await postForm("/api/files/upload", form);
        toast(`uploaded ${file.name}`);
      } catch (e) {
        toast(e instanceof Error ? e.message : `upload failed: ${file.name}`, true);
      }
    }
    if (uploadInput) uploadInput.value = "";
    await browse();
  }

  async function deleteFile(rel: string, name: string): Promise<void> {
    if (!confirm(`Delete "${name}"?`)) return;
    try {
      await deleteRequest(`/api/files?path=${encodeURIComponent(rel)}`);
      toast(`deleted ${name}`);
      await browse();
    } catch (e) {
      toast(e instanceof Error ? e.message : "delete failed", true);
    }
  }

  async function downloadFile(rel: string, name: string): Promise<void> {
    try {
      const r = await fetch(`/api/files/download?path=${encodeURIComponent(rel)}`);
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || `download failed: ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toast(e instanceof Error ? e.message : "download failed", true);
    }
  }

  // ── patterns ─────────────────────────────────────────────────────────
  const [patterns, setPatterns] = createSignal<PatternInfo[]>([]);
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [pName, setPName] = createSignal("");
  const [pCode, setPCode] = createSignal("");

  async function loadPatterns(): Promise<void> {
    try {
      const d = await getJSON<{ patterns?: PatternInfo[] }>("/api/patterns");
      setPatterns(d.patterns ?? []);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not load patterns", true);
    }
  }

  async function viewPattern(name: string): Promise<void> {
    try {
      const d = await getJSON<{ name?: string; content?: string }>(
        `/api/patterns/${encodeURIComponent(name)}`,
      );
      setPName(d.name || name);
      setPCode(d.content || "");
      setEditorOpen(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not open pattern", true);
    }
  }

  function showNewPattern(): void {
    setPName("");
    setPCode(NEW_PATTERN_TEMPLATE);
    setEditorOpen(true);
  }

  async function savePattern(): Promise<void> {
    const name = pName().trim();
    if (!name) {
      toast("pattern name required", true);
      return;
    }
    if (!pCode().trim()) {
      toast("pattern code required", true);
      return;
    }
    try {
      await postJSON("/api/patterns", { name, content: pCode() });
      toast("pattern saved");
      setEditorOpen(false);
      await loadPatterns();
    } catch (e) {
      toast(e instanceof Error ? e.message : "save failed", true);
    }
  }

  async function deletePattern(name: string): Promise<void> {
    if (!confirm(`Delete pattern "${name}"?`)) return;
    try {
      await deleteRequest(`/api/patterns/${encodeURIComponent(name)}`);
      toast("pattern deleted");
      await loadPatterns();
    } catch (e) {
      toast(e instanceof Error ? e.message : "delete failed", true);
    }
  }

  // ── secrets ──────────────────────────────────────────────────────────
  const [secrets, setSecrets] = createSignal<SecretInfo[]>([]);
  let importInput: HTMLInputElement | undefined;

  async function loadSecrets(): Promise<void> {
    try {
      const d = await getJSON<{ secrets?: SecretInfo[] }>("/api/secrets");
      setSecrets(d.secrets ?? []);
    } catch {
      setSecrets([]);
    }
  }

  async function importSecrets(): Promise<void> {
    const file = importInput?.files?.[0];
    if (!file) {
      toast("pick a secrets.db file first", true);
      return;
    }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        bin += String.fromCharCode(...buf.subarray(i, i + chunk));
      }
      const d = await postJSON<{ ok?: boolean; imported?: number; error?: string }>(
        "/api/secrets/import",
        { base64: btoa(bin) },
      );
      if (d.error || d.ok === false) throw new Error(d.error || "import failed");
      toast(`imported ${d.imported || 0} secret(s)`);
      if (importInput) importInput.value = "";
      await loadSecrets();
    } catch (e) {
      toast(e instanceof Error ? e.message : "import failed", true);
    }
  }

  // ── git / workspace sync ─────────────────────────────────────────────
  const [syncLocal, setSyncLocal] = createSignal("main");
  const [syncRemote, setSyncRemote] = createSignal("main");
  const [syncText, setSyncText] = createSignal("(not synced yet)");
  const [syncState, setSyncState] = createSignal<"idle" | "busy" | "ok" | "err">("idle");

  function syncResult(r: SyncResponse, done: string, failed: string): void {
    const ok = r.ok !== false;
    setSyncState(ok ? "ok" : "err");
    setSyncText(
      `${ok ? "✓" : "✗"} ${ok ? done : failed}${r.output ? `\n${r.output}` : ""}${
        r.error ? `\n${r.error}` : ""
      }`,
    );
    toast(ok ? done : failed, !ok);
  }

  async function commitWorkspace(): Promise<void> {
    const message = (prompt('Commit message (blank = "manual commit from admin UI"):') || "").trim();
    setSyncState("busy");
    setSyncText("committing...");
    try {
      const r = await postJSON<SyncResponse>("/api/commit", { message });
      if (r.committed) {
        setSyncState("ok");
        setSyncText(`committed ${r.hash}${r.output ? `:\n${r.output}` : ""}`);
        toast(`committed ${r.hash}`);
      } else if (r.ok) {
        setSyncState("ok");
        setSyncText("nothing to commit (clean workspace)");
        toast("workspace clean");
      } else {
        setSyncState("err");
        setSyncText(`error: ${r.error || "commit failed"}`);
        toast("commit failed", true);
      }
    } catch (e) {
      setSyncState("err");
      setSyncText(`error: ${e instanceof Error ? e.message : "commit failed"}`);
      toast("commit failed", true);
    }
  }

  async function pullWorkspace(): Promise<void> {
    const local = syncLocal().trim() || "main";
    const remote = syncRemote().trim() || local;
    setSyncState("busy");
    setSyncText(`pulling ${remote}...`);
    try {
      const r = await postJSON<SyncResponse>("/api/sync/pull", { local, remote });
      syncResult(r, `pulled ${remote}`, `pull failed: ${remote}`);
    } catch (e) {
      setSyncState("err");
      setSyncText(`✗ ${e instanceof Error ? e.message : "pull failed"}`);
      toast("pull failed", true);
    }
  }

  async function pushWorkspace(): Promise<void> {
    const local = syncLocal().trim() || "main";
    const remote = syncRemote().trim() || local;
    setSyncState("busy");
    setSyncText(`pushing ${local} → ${remote}...`);
    try {
      const r = await postJSON<SyncResponse>("/api/sync/push", { local, remote });
      syncResult(r, `pushed ${local} → ${remote}`, `push failed: ${local} → ${remote}`);
    } catch (e) {
      setSyncState("err");
      setSyncText(`error: ${e instanceof Error ? e.message : "push failed"}`);
      toast("push failed", true);
    }
  }

  onMount(() => {
    void browse("");
    void loadPatterns();
    void loadSecrets();
  });

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">
          <img class="brand-mark" src={logoMark} alt="" aria-hidden="true" />
        </span>
        <span class="admin-title">files</span>
        <span class="spacer" />
        <nav class="admin-nav">
          <button type="button" class="link-btn" onClick={props.onSettings}>
            settings
          </button>
          <button type="button" class="link-btn" onClick={props.onChat}>
            ← chat
          </button>
        </nav>
        <span class="build-stamp" title={buildInfo.title}>
          {buildInfo.label}
        </span>
      </header>

      <div class="admin-page">
        <section class="admin-card">
          <h2>Files</h2>
          <p>
            <small>Browse, upload, and download files in the workspace.</small>
          </p>
          <div class="row" style={{ "margin-bottom": "8px" }}>
            <button class="secondary" type="button" onClick={() => void browse()}>
              ↻ Refresh
            </button>
            <button
              class="secondary"
              type="button"
              disabled={!dir()}
              onClick={() => void browse(parentPath(dir()))}
            >
              ↑ Up
            </button>
            <span class="file-path">/{dir() || "(root)"}</span>
          </div>
          <div class="file-list">
            <Show when={files().length} fallback={<small class="muted">(empty directory)</small>}>
              <For each={files()}>
                {(file) => {
                  const rel = () => joinPath(dir(), file.name);
                  return (
                    <div class="file-row">
                      <span class="file-action">
                        <Show when={!file.isDir}>
                          <a
                            href={`/api/files/download?path=${encodeURIComponent(rel())}`}
                            title="Download"
                            aria-label="Download"
                            onClick={(e) => {
                              e.preventDefault();
                              void downloadFile(rel(), file.name);
                            }}
                          >
                            ↓
                          </a>
                        </Show>
                      </span>
                      <span
                        class={`file-name${file.isDir ? " dir" : ""}`}
                        onClick={() => file.isDir && void browse(rel())}
                      >
                        {file.isDir ? "📁 " : "📄 "}
                        {file.name}
                      </span>
                      <span class="file-size">{file.isDir ? "dir" : formatSize(file.size)}</span>
                      <span class="file-mtime">
                        {file.mtime ? new Date(file.mtime).toLocaleString() : ""}
                      </span>
                      <span class="file-action">
                        <Show when={!file.isDir}>
                          <button
                            class="danger"
                            type="button"
                            title="Delete"
                            aria-label="Delete"
                            onClick={() => void deleteFile(rel(), file.name)}
                          >
                            ×
                          </button>
                        </Show>
                      </span>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
          <div class="actions">
            <input
              ref={(el) => (uploadInput = el)}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => void uploadFiles(e.currentTarget.files)}
            />
            <button type="button" onClick={() => uploadInput?.click()}>
              Upload file
            </button>
          </div>
        </section>

        <section class="admin-card">
          <h2>Tree patterns</h2>
          <p>
            <small>
              grandma-kat trees (<code>patterns/&lt;name&gt;.prod.mjs</code>) in{" "}
              <code>workspace/patterns/</code>. The agent re-reads the active tree each turn — edit it to change
              behavior without restarting. The agent can also modify its own patterns using file tools.{" "}
              <b>Which one runs</b> is selected from the dropdown on the chat page (persisted as{" "}
              <code>TREE_PATTERN</code> in <code>.env</code>).
            </small>
          </p>
          <div>
            <Show
              when={patterns().length}
              fallback={
                <small class="muted">
                  No patterns yet. Click "New pattern" to create one.
                </small>
              }
            >
              <For each={patterns()}>
                {(pattern) => (
                  <div class="pattern-row">
                    <div>
                      <strong>{pattern.name || pattern.file}</strong>{" "}
                      <small class="muted">— {pattern.description || "(no description)"}</small>
                    </div>
                    <div class="pattern-actions">
                      <button
                        class="secondary"
                        type="button"
                        onClick={() => void viewPattern(pattern.name || pattern.file || "")}
                      >
                        View
                      </button>
                      <button
                        class="danger"
                        type="button"
                        onClick={() => void deletePattern(pattern.name || pattern.file || "")}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <div class="actions">
            <button class="secondary" type="button" onClick={() => void loadPatterns()}>
              Refresh
            </button>
            <button type="button" onClick={showNewPattern}>
              New pattern
            </button>
          </div>
          <Show when={editorOpen()}>
            <div style={{ "margin-top": "12px" }}>
              <label>Pattern name (no spaces, e.g. "my-pattern")</label>
              <input
                type="text"
                placeholder="my-pattern"
                value={pName()}
                onInput={(e) => setPName(e.currentTarget.value)}
              />
              <label>Pattern code (.prod.mjs — export default async function)</label>
              <textarea
                style={{
                  width: "100%",
                  "min-height": "220px",
                  resize: "vertical",
                  font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
                value={pCode()}
                onInput={(e) => setPCode(e.currentTarget.value)}
              />
              <div class="actions">
                <button type="button" onClick={() => void savePattern()}>
                  Save pattern
                </button>
                <button class="secondary" type="button" onClick={() => setEditorOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </Show>
        </section>

        <section class="admin-card">
          <h2>App secrets</h2>
          <p>
            <small>
              Files an app requested in <code>app/&lt;name&gt;/secrets.json</code>. Uploaded bytes live in the
              local secret store — gitignored, invisible to the file browser and to the bot's file tools. An app
              reads only its own secrets.
            </small>
          </p>
          <div>
            <Show when={secrets().length} fallback={<small class="muted">(no app has requested secret files yet)</small>}>
              <For each={secrets()}>
                {(secret) => <SecretCard secret={secret} onChanged={() => void loadSecrets()} />}
              </For>
            </Show>
          </div>
          <div class="actions" style={{ "margin-top": "12px" }}>
            <input
              ref={(el) => (importInput = el)}
              type="file"
              accept=".db,application/octet-stream"
              style={{ "max-width": "260px" }}
            />
            <button type="button" onClick={() => void importSecrets()}>
              import secrets.db
            </button>
            <small class="muted">
              load a desktop <code>secrets.db</code> (its <code>app_secrets</code> rows) into this platform
            </small>
          </div>
        </section>

        <section class="admin-card">
          <h2>Workspace sync</h2>
          <p>
            <small>
              Push/pull the workspace to/from the desktop's git-daemon (port 9418). The bot auto-commits file
              changes; use these to sync with the desktop.
            </small>
          </p>
          <label>Local branch → Remote branch</label>
          <div class="row">
            <input
              type="text"
              value={syncLocal()}
              placeholder="main"
              style={{ width: "120px" }}
              onInput={(e) => setSyncLocal(e.currentTarget.value)}
            />
            <span class="muted">→</span>
            <input
              type="text"
              value={syncRemote()}
              placeholder="main"
              style={{ width: "120px" }}
              onInput={(e) => setSyncRemote(e.currentTarget.value)}
            />
          </div>
          <div class={`sync-status ${syncState()}`}>{syncText()}</div>
          <div class="actions">
            <button type="button" onClick={() => void commitWorkspace()}>
              Commit workspace
            </button>
            <button type="button" onClick={() => void pullWorkspace()}>
              Pull from desktop
            </button>
            <button type="button" onClick={() => void pushWorkspace()}>
              Push to desktop
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
