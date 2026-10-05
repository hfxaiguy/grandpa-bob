// Shared UI pages — the exact Node admin HTML, rendered verbatim by both the
// Node server and the browser target, so they share one UI.

export interface UiConfig {
  port: number;
}

export function buildSettingsHtml(config: UiConfig): string {
  const PORT = config.port;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grandpa-bob settings</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --fg:#e2e8f0; --muted:#94a3b8; --accent:#3b82f6; --green:#10b981; --red:#ef4444; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 16px; max-width: 900px; margin: 0 auto; }
  .topnav { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .topnav a { color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 600; margin-left: auto; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 16px; margin: 24px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .card { background: var(--card); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.on { background: var(--green); }
  .dot.off { background: var(--red); }
  .dot.na { background: var(--muted); }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input[type=text], input[type=password], textarea, select { width: 100%; padding: 10px 12px; background: #0b1224; color: var(--fg); border: 1px solid #334155; border-radius: 6px; font: 14px ui-monospace, monospace; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
  input.env-key { background: transparent; border: none; color: var(--muted); font: 12px ui-monospace, monospace; width: auto; min-width: 80px; padding: 0; }
  input.env-key:focus { outline: none; border-bottom: 1px solid var(--accent); color: var(--fg); }
  button { background: var(--accent); color: white; border: none; padding: 10px 18px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button.secondary { background: #475569; }
  button.danger { background: var(--red); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  pre { background: #0b1224; color: #cbd5e1; padding: 12px; border-radius: 6px; font: 12px ui-monospace, monospace; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .toast { position: fixed; top: 16px; right: 16px; background: var(--green); color: white; padding: 10px 16px; border-radius: 6px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.err { background: var(--red); }
  a { color: var(--accent); }
  small { color: var(--muted); }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 600px) { .grid-2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="topnav">
  <h1>grandpa-bob settings</h1>
  <a href="/">&larr; chat</a>
</div>

<div class="card">
  <div class="row">
    <span id="service-dots" class="row" style="gap:14px"></span>
    <span class="status"><span class="dot on"></span> admin (this)</span>
    <span style="margin-left:auto"><small id="uptime"></small></span>
  </div>
  <div class="row" style="margin-top:8px">
    <label class="status" title="The webui automatically continues whichever conversation is live on Telegram. Telegram never picks up web chats.">
      <input type="checkbox" id="follow-chk" style="margin:0 6px 0 0"> webui follows telegram
    </label>
    <small style="color:var(--muted)">one-way: telegram never follows the webui</small>
  </div>
  <div class="actions">
    <button onclick="restartBot()">Restart bot</button>
    <button class="secondary" onclick="refreshAll()">Refresh</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">App secrets</h2>
  <p style="margin:4px 0"><small>Files an app requested in <code>app/&lt;name&gt;/secrets.json</code>. Uploaded bytes live in <code>logs/secrets.db</code> &mdash; local, gitignored, invisible to the file browser and to the bot's file tools. An app reads only its own secrets.</small></p>
  <div id="secrets-list">(loading...)</div>
  <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <input id="secrets-import-file" type="file" accept=".db,application/octet-stream" style="max-width:260px">
    <button id="secrets-import-btn">import secrets.db</button>
    <small style="color:var(--muted)">load a desktop <code>secrets.db</code> (its <code>app_secrets</code> rows) into this platform</small>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Workspace sync</h2>
  <p style="margin:4px 0"><small>Push/pull the workspace to/from the desktop's git-daemon (port 9418). The bot auto-commits file changes; use these to sync with the desktop.</small></p>
  <label>Local branch → Remote branch</label>
  <div class="row">
    <input id="sync-local" type="text" value="master" placeholder="master" style="width:120px">
    <span style="color:var(--muted)">→</span>
    <input id="sync-remote" type="text" value="master" placeholder="master" style="width:120px">
  </div>
  <div id="sync-status" style="margin:8px 0; font:12px ui-monospace,monospace; color:var(--muted)">(not synced yet)</div>
  <div class="actions">
    <button onclick="gitCommit()">Commit workspace</button>
    <button onclick="gitPull()">Pull from desktop</button>
    <button onclick="gitPush()">Push to desktop</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Credentials &amp; .env</h2>
  <form id="envForm" onsubmit="saveEnv(event)">
    <div class="grid-2">
      <div>
        <label>Telegram bot token <span id="cur-token" style="float:right"></span></label>
        <input id="f-token" type="password" placeholder="123456:ABC-DEF...">
      </div>
      <div>
        <label>Your Telegram user ID <span id="cur-uid" style="float:right"></span></label>
        <input id="f-uid" type="text" inputmode="numeric" placeholder="123456789">
      </div>
    </div>
    <label>Hugging Face API key <span id="cur-hf" style="float:right"></span></label>
    <input id="f-hf" type="password" placeholder="hf_...">
    <label>Ollama API key <span id="cur-ollama" style="float:right"></span></label>
    <input id="f-ollama" type="password" placeholder="ollama-api-key...">
    <small>Shortcuts for the most common keys — every other key in <code>.env</code> is editable below.</small>
    <div class="actions">
      <button type="submit">Save credentials</button>
    </div>
  </form>
  <div style="margin:16px 0; border-top:1px solid var(--border,#334155)"></div>
  <h3 style="margin:0 0 8px; font-size:14px">All .env keys</h3>
  <p style="margin:0 0 8px"><small>Values visible. Edit a value, rename a key, add or remove keys. Changes apply after a bot restart.</small></p>
  <div id="env-keys">(loading...)</div>
  <div class="actions">
    <button class="secondary" onclick="addEnvKey()">+ Add key</button>
    <button onclick="saveAllEnv()">Save all keys</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Models</h2>
  <p style="margin:4px 0"><small>The model registry (JSON). In the browser target this is stored in <b>browser settings</b>, never in the workspace, so API keys don't land in git. Keys may use <code>\${ENV}</code> to reference the credentials above.</small></p>
  <textarea id="models-json" rows="9" style="width:100%;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace" placeholder='{"default":{"baseURL":"https://ollama.com","apiKey":"\${OLLAMA_API_KEY}","model":"gemma4:31b-cloud","protocol":"ollama"}}'></textarea>
  <div class="actions">
    <button onclick="saveModels()">Save models</button>
    <span id="models-status"></span>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Logs</h2>
  <div class="row" style="margin-bottom:8px">
    <button class="secondary" onclick="loadLog('bot')">bot.log</button>
    <button class="secondary" onclick="loadLog('sherpa')">sherpa.log</button>
    <span style="margin-left:auto"><small>last 60 lines</small></span>
  </div>
  <pre id="log">(click a log button)</pre>
</div>

<div class="card">
  <h2 style="margin-top:0">Tree patterns</h2>
  <p style="margin:4px 0"><small>grandma-kat Tree patterns (<code>.mjs</code>) in <code>workspace/patterns/</code>. The agent re-reads the active pattern on each turn — edit it to change behavior without restarting. The agent can also modify its own patterns using file tools. <b>Which one runs</b> is selected from the dropdown on the <a href="/" style="color:var(--accent)">chat page</a> (persisted as <code>TREE_PATTERN</code> in <code>.env</code>).</small></p>
  <div id="pattern-list">(loading...)</div>
  <div class="actions">
    <button class="secondary" onclick="refreshPatterns()">Refresh</button>
    <button onclick="showNewPattern()">New pattern</button>
  </div>
  <div id="pattern-editor" style="display:none; margin-top:12px">
    <label>Pattern name (no spaces, e.g. "my-pattern")</label>
    <input id="p-name" type="text" placeholder="my-pattern">
    <label>Pattern code (.mjs — export default async function)</label>
    <textarea id="p-code" style="width:100%; min-height:200px; background:#0b1224; color:#cbd5e1; border:1px solid #334155; border-radius:6px; padding:12px; font:12px ui-monospace,monospace; resize:vertical"></textarea>
    <div class="actions">
      <button onclick="savePattern()">Save pattern</button>
      <button class="secondary" onclick="hideNewPattern()">Cancel</button>
    </div>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Files</h2>
  <p style="margin:4px 0"><small>Browse, upload, and download files in the workspace.</small></p>
  <div id="file-nav" class="row" style="margin-bottom:8px; flex-wrap:wrap">
    <button class="secondary" onclick="filesBrowse()">↻ Refresh</button>
    <span id="file-path" style="margin-left:auto; font-size:12px; color:var(--muted)">/</span>
  </div>
  <div id="file-list" style="max-height:300px; overflow:auto; border:1px solid #334155; border-radius:6px; padding:8px; background:#0b1224; font:12px ui-monospace,monospace">(loading...)</div>
  <div class="actions" style="margin-top:8px">
    <input id="file-upload-input" type="file" style="display:none" onchange="uploadFile(this)" multiple />
    <button onclick="document.getElementById('file-upload-input').click()">Upload file</button>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Access</h2>
  <p style="margin:4px 0"><small>This UI runs on the phone at <code>http://0.0.0.0:${PORT}</code>.</small></p>
  <p style="margin:4px 0"><small>If you're on the same Wi-Fi, open <code>http://&lt;phone-ip&gt;:${PORT}</code> from your laptop.</small></p>
  <p style="margin:4px 0"><small>To expose to the internet, run an SSH reverse tunnel or use Termux's <code>pkg install cloudflared</code>.</small></p>
</div>

<div id="toast" class="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let startedAt = Date.now();
// Wall-clock start of the bot process, derived from server-reported uptime.
// Null until the first status response; falls back to the page clock.
let botUptimeBase = null;
let envRows = []; // { key, orig, value, removed } — orig = key as loaded from .env
let currentDir = "";

function toast(msg, isErr, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => t.className = "toast" + (isErr ? " err" : ""), ms || (isErr ? 6000 : 3500));
}

function syncResult(r, done, failed) {
  const ok = r.ok !== false;
  $("sync-status").textContent = (ok ? "✓ " + done : "✗ " + failed) + (r.output ? "\\n" + r.output : "");
  $("sync-status").style.color = ok ? "var(--green)" : "var(--red)";
  toast(ok ? done : failed, !ok, ok ? 3500 : 8000);
}

async function api(path, opts) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { toast(data.error || \`HTTP \${r.status}\`, true); throw new Error(data.error); }
  return data;
}

async function refreshStatus() {
  const s = await api("/api/status");
  // Service health: telegram / voice / llm dots with detail tooltips,
  // probed server-side (getMe, HTTP health endpoints, model reachability).
  const dots = $("service-dots");
  dots.innerHTML = "";
  for (const svc of s.services || []) {
    const el = document.createElement("span");
    el.className = "status";
    el.title = svc.detail;
    const dot = document.createElement("span");
    dot.className = "dot " + (svc.up === true ? "on" : svc.up === false ? "off" : "na");
    el.append(dot, " " + svc.name);
    dots.appendChild(el);
  }
  botUptimeBase = typeof s.uptimeSec === "number" ? Date.now() - s.uptimeSec * 1000 : null;
  if (s.pid) $("uptime").title = "bot process pid " + s.pid;
  const env = s.env || {};
  $("cur-token").textContent  = env.TELEGRAM_BOT_TOKEN ? "current: " + env.TELEGRAM_BOT_TOKEN.slice(0,8) + "..." : "(unset)";
  $("cur-uid").textContent    = env.ALLOWED_USER_IDS    ? "current: " + env.ALLOWED_USER_IDS : "(unset)";
  $("cur-hf").textContent     = env.LLM_API_KEY         ? "current: " + env.LLM_API_KEY.slice(0,6) + "..." : "(unset)";
  $("cur-ollama").textContent = env.OLLAMA_API_KEY      ? "current: " + env.OLLAMA_API_KEY.slice(0,6) + "..." : "(unset)";
  // Populate the all-keys editor only when it's not holding unsaved edits.
  if (!envRows.length) {
    envRows = Object.entries(env).map(([key, value]) => ({ key, orig: key, value: String(value), removed: false }));
    renderEnvKeys();
  }
}

function renderEnvKeys() {
  const box = $("env-keys");
  if (!box) return;
  box.innerHTML = "";
  const rows = envRows.filter((r) => !r.removed);
  if (!rows.length) { box.textContent = "(no keys — add one below)"; return; }
  rows.forEach((r) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:10px";
    const lab = document.createElement("label");
    lab.style.cssText = "margin-top:0";
    const k = document.createElement("input");
    k.className = "env-key";
    k.value = r.key;
    k.placeholder = "KEY NAME";
    k.spellcheck = false;
    k.oninput = () => { r.key = k.value; };
    const del = document.createElement("button");
    del.className = "secondary";
    del.textContent = "×";
    del.title = "Remove this key";
    del.style.cssText = "float:right;padding:2px 10px";
    del.onclick = () => { r.removed = true; renderEnvKeys(); };
    const v = document.createElement("input");
    v.className = "env-val";
    v.type = "text";
    v.value = r.value;
    v.placeholder = "value";
    v.oninput = () => { r.value = v.value; };
    lab.append(k, del);
    wrap.append(lab, v);
    box.appendChild(wrap);
  });
}

function addEnvKey() {
  envRows.push({ key: "", orig: "", value: "", removed: false });
  renderEnvKeys();
}

function collectEnvUpdates() {
  const updates = {};
  for (const r of envRows) {
    if (r.removed) {
      if (r.key) updates[r.key] = null;
      continue;
    }
    const key = r.key.trim();
    if (!key) continue;
    if (r.orig && r.orig !== key && !(r.orig in updates)) updates[r.orig] = null;
    updates[key] = r.value;
  }
  return updates;
}

async function saveAllEnv() {
  const updates = collectEnvUpdates();
  if (!Object.keys(updates).length) { toast("nothing to change", true); return; }
  try {
    await api("/api/env", { method: "POST", body: JSON.stringify(updates) });
    toast("saved — restart the bot to apply");
    envRows = [];
    renderEnvKeys();
    await refreshStatus();
  } catch {}
}

// ---- app secrets -----------------------------------------------------
// Expand dotted keys ("auth.token") into a nested object when building JSON.
function setPath(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

async function loadSecrets() {
  const box = $("secrets-list");
  if (!box) return;
  try {
    const d = await api("/api/secrets");
    box.innerHTML = "";
    if (!d.secrets || !d.secrets.length) {
      box.textContent = "(no app has requested secret files yet)";
      return;
    }
    for (const s of d.secrets) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--border,#334155)";
      const info = document.createElement("span");
      info.style.cssText = "flex:1 1 300px;font-size:13px";
      const head = document.createElement("span");
      const appB = document.createElement("b");
      appB.textContent = s.app;
      head.append(appB, document.createTextNode(" / " + s.name + " "));
      const desc = document.createElement("small");
      desc.style.color = "var(--muted)";
      desc.textContent = s.description || "";
      const br = document.createElement("br");
      const status = document.createElement("small");
      status.style.color = s.present ? "var(--green,#10b981)" : "var(--red,#ef4444)";
      const isJson = String(s.contentType || "").indexOf("json") >= 0 || (s.fields && Object.keys(s.fields).length > 0);
      status.textContent = s.present
        ? "\u2713 " + new Date(s.updatedAt).toLocaleString() + " \u00b7 " + s.size + " B"
        : (isJson ? "missing \u2014 enter the values below" : "missing \u2014 upload it below");
      info.append(head, desc, br, status);

      const pick = document.createElement("input");
      pick.type = "file";
      pick.style.maxWidth = "220px";
      const up = document.createElement("button");
      up.textContent = s.present ? "replace" : "upload";
      up.onclick = async () => {
        if (!pick.files || !pick.files[0]) { toast("pick a file first", true); return; }
        const fd = new FormData();
        fd.append("file", pick.files[0]);
        try {
          const r = await fetch("/api/secrets?app=" + encodeURIComponent(s.app) + "&name=" + encodeURIComponent(s.name), { method: "POST", body: fd });
          const d2 = await r.json().catch(() => ({}));
          if (!r.ok) { toast(d2.error || "upload failed", true); return; }
          toast("stored " + s.app + "/" + s.name);
          loadSecrets();
        } catch (e) { toast("upload failed: " + e.message, true); }
      };

      if (isJson) {
        // Key/value editor for JSON secrets; dotted keys expand to nested
        // objects (auth.token -> { auth: { token } }).
        const editor = document.createElement("div");
        editor.style.cssText = "flex:1 1 100%;display:flex;flex-direction:column;gap:6px";
        const rowsBox = document.createElement("div");
        rowsBox.style.cssText = "display:flex;flex-direction:column;gap:4px";
        const addRow = (key, hint) => {
          const r = document.createElement("div");
          r.style.cssText = "display:flex;gap:6px;align-items:center";
          const k = document.createElement("input");
          k.placeholder = "key (e.g. auth.token)";
          k.value = key || "";
          k.style.flex = "0 0 200px";
          const v = document.createElement("input");
          v.placeholder = hint || "value";
          v.style.flex = "1 1 auto";
          const rm = document.createElement("button");
          rm.className = "secondary";
          rm.textContent = "\u00d7";
          rm.onclick = () => r.remove();
          r.append(k, v, rm);
          rowsBox.appendChild(r);
        };
        const fieldKeys = s.fields ? Object.keys(s.fields) : [];
        if (fieldKeys.length) fieldKeys.forEach((k) => addRow(k, s.fields[k] || ""));
        else addRow("", "");
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center";
        const add = document.createElement("button");
        add.className = "secondary";
        add.textContent = "+ add var";
        add.onclick = () => addRow("", "");
        const save = document.createElement("button");
        save.textContent = "Save vars";
        save.onclick = async () => {
          const value = {};
          let bad = "";
          rowsBox.querySelectorAll("div").forEach((r) => {
            const inputs = r.querySelectorAll("input");
            const key = inputs[0].value.trim();
            const val = inputs[1].value;
            if (!key) return;
            if (!/^[A-Za-z0-9_.-]+$/.test(key)) { bad = key; return; }
            if (val === "") return;
            setPath(value, key, val);
          });
          if (bad) { toast("invalid key: " + bad, true); return; }
          if (!Object.keys(value).length) { toast("enter at least one value", true); return; }
          try {
            const r = await fetch("/api/secrets/vars?app=" + encodeURIComponent(s.app) + "&name=" + encodeURIComponent(s.name), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ value }),
            });
            const d2 = await r.json().catch(() => ({}));
            if (!r.ok) { toast(d2.error || "save failed", true); return; }
            toast("stored vars for " + s.app + "/" + s.name);
            loadSecrets();
          } catch (e) { toast("save failed: " + e.message, true); }
        };
        actions.append(add, save);
        editor.append(rowsBox, actions);
        const fallback = document.createElement("details");
        const sum = document.createElement("summary");
        sum.textContent = "or upload a file instead";
        sum.style.cssText = "cursor:pointer;font-size:12px;color:var(--muted)";
        fallback.append(sum, pick, up);
        row.append(info, editor, fallback);
      } else {
        row.append(info, pick, up);
      }
      if (s.present) {
        const del = document.createElement("button");
        del.className = "secondary";
        del.textContent = "delete";
        del.onclick = async () => {
          if (!confirm("Delete stored secret " + s.app + "/" + s.name + "?")) return;
          try {
            await api("/api/secrets?app=" + encodeURIComponent(s.app) + "&name=" + encodeURIComponent(s.name), { method: "DELETE" });
            toast("deleted " + s.name);
            loadSecrets();
          } catch { /* api() toasted */ }
        };
        row.appendChild(del);
      }
      box.appendChild(row);
    }
  } catch {
    box.textContent = "(failed to load secrets)";
  }
}

// Import a desktop secrets.db (its app_secrets table) into this platform's
// store — the browser keeps secrets in localStorage, so it can't read the
// file directly; the backend opens it and copies the rows.
const secretsImportFile = $("secrets-import-file");
const secretsImportBtn = $("secrets-import-btn");
if (secretsImportBtn && secretsImportFile) {
  secretsImportBtn.onclick = async () => {
    const file = secretsImportFile.files && secretsImportFile.files[0];
    if (!file) { toast("pick a secrets.db file first", true); return; }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
      }
      const r = await fetch("/api/secrets/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ base64: btoa(bin) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error || d.ok === false) { toast(d.error || "import failed", true); return; }
      toast("imported " + (d.imported || 0) + " secret(s)");
      loadSecrets();
    } catch (e) {
      toast("import failed: " + e.message, true);
    }
  };
}

async function loadModels() {
  try {
    const d = await api("/api/models");
    const t = $("models-json");
    if (t) t.value = d.json || "";
  } catch { /* optional */ }
}
async function saveModels() {
  const t = $("models-json");
  if (!t) return;
  try {
    await api("/api/models", { method: "POST", body: JSON.stringify({ json: t.value }) });
    toast("models saved");
  } catch (e) { toast("models save failed: " + e.message, true); }
}

async function refreshAll() {
  try { await refreshStatus(); toast("refreshed"); } catch (e) {}
}

async function saveEnv(e) {
  e.preventDefault();
  const body = {};
  if ($("f-token").value)  body.TELEGRAM_BOT_TOKEN = $("f-token").value;
  if ($("f-uid").value)    body.ALLOWED_USER_IDS    = $("f-uid").value;
  if ($("f-hf").value)     body.LLM_API_KEY         = $("f-hf").value;
  if ($("f-ollama").value) body.OLLAMA_API_KEY      = $("f-ollama").value;
  if (Object.keys(body).length === 0) { toast("nothing to save", true); return; }
  try {
    await api("/api/env", { method: "POST", body: JSON.stringify(body) });
    toast("saved");
    $("f-token").value = $("f-uid").value = $("f-hf").value = $("f-ollama").value = "";
    await refreshStatus();
  } catch {}
}

async function restartBot() {
  try { await api("/api/restart-bot", { method: "POST" }); toast("bot restarting..."); setTimeout(refreshStatus, 2000); } catch {}
}

async function gitCommit() {
  const msg = (prompt('Commit message (blank = "manual commit from admin UI"):') || "").trim();
  $("sync-status").textContent = "committing...";
  try {
    const r = await api("/api/commit", { method: "POST", body: JSON.stringify({ message: msg }) });
    const line = r.committed
      ? \`committed \${r.hash}\${r.output ? ":\\n" + r.output : ""}\`
      : (r.ok ? "nothing to commit (clean workspace)" : "error");
    $("sync-status").textContent = line;
    toast(r.ok ? (r.committed ? "committed " + r.hash : "workspace clean") : "commit failed", !r.ok);
  } catch (e) { $("sync-status").textContent = "error: " + e.message; }
}

async function gitPull() {
  const local = $("sync-local").value.trim() || "master";
  const remote = $("sync-remote").value.trim() || local;
  $("sync-status").textContent = "pulling " + remote + "...";
  $("sync-status").style.color = "var(--muted)";
  try {
    const r = await api("/api/sync/pull", { method: "POST", body: JSON.stringify({ local, remote }) });
    syncResult(r, "pulled " + remote, "pull failed: " + remote);
  } catch (e) { $("sync-status").textContent = "✗ " + e.message; $("sync-status").style.color = "var(--red)"; toast("pull failed", true, 8000); }
}

async function gitPush() {
  const local = $("sync-local").value.trim() || "master";
  const remote = $("sync-remote").value.trim() || local;
  $("sync-status").textContent = "pushing " + local + " → " + remote + "...";
  $("sync-status").style.color = "var(--muted)";
  try {
    const r = await api("/api/sync/push", { method: "POST", body: JSON.stringify({ local, remote }) });
    syncResult(r, "pushed " + local + " → " + remote, "push failed: " + local + " → " + remote);
  } catch (e) { $("sync-status").textContent = "error: " + e.message; $("sync-status").style.color = "var(--red)"; toast("push failed", true, 8000); }
}

async function loadLog(name) {
  try {
    const r = await api("/api/log?file=" + name);
    $("log").textContent = r.content || "(empty)";
  } catch {}
}

async function refreshPatterns() {
  try {
    const r = await api("/api/patterns");
    const list = $("pattern-list");
    if (r.patterns.length === 0) {
      list.innerHTML = '<small style="color:var(--muted)">No patterns yet. Click "New pattern" to create one.</small>';
      return;
    }
    list.innerHTML = r.patterns.map(p => {
      const name = p.name || p.file;
      const desc = p.description || "(no description)";
      return \`<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #334155">
        <div>
          <strong>\${name}</strong> <small style="color:var(--muted)">— \${desc}</small>
        </div>
        <div>
          <button class="secondary" style="padding:4px 8px; font-size:12px" onclick="viewPattern('\${name}')">View</button>
          <button class="danger" style="padding:4px 8px; font-size:12px" onclick="deletePattern('\${name}')">Delete</button>
        </div>
      </div>\`;
    }).join("");
  } catch {}
}

async function viewPattern(name) {
  try {
    const r = await api("/api/patterns/" + name);
    $("p-name").value = r.name || name;
    $("p-code").value = r.content || "";
    $("pattern-editor").style.display = "block";
  } catch {}
}

function showNewPattern() {
  $("p-name").value = "";
  $("p-code").value = \`// my-pattern.mjs — description of what this pattern does
//
// The function receives the Tree element surface as arguments.
// Available: { Tree, name, Model, Tools, Human, Prompt, Memory, Emit, Return, Until, when, max }
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

export default function({ Tree, name, Human, Prompt, Emit, Until, max }) {
  return Tree(
    name("my-pattern"),
    Human("main_input"),
    Prompt((m) => "You said: " + m.main_input + ". Respond briefly."),
    Emit((m) => m.prev[0]),
    Until(() => false, max(100000)),
  );
}
\`;
  $("pattern-editor").style.display = "block";
}

function hideNewPattern() { $("pattern-editor").style.display = "none"; }

async function savePattern() {
  const name = $("p-name").value.trim();
  if (!name) { toast("pattern name required", true); return; }
  const content = $("p-code").value;
  if (!content.trim()) { toast("pattern code required", true); return; }
  try {
    await api("/api/patterns", { method: "POST", body: JSON.stringify({ name, content }) });
    toast("pattern saved");
    hideNewPattern();
    refreshPatterns();
  } catch {}
}

async function deletePattern(name) {
  if (!confirm(\`Delete pattern "\${name}"?\`)) return;
  try { await api("/api/patterns/" + name, { method: "DELETE" }); toast("pattern deleted"); refreshPatterns(); } catch {}
}

// ----- file browser -----
async function filesBrowse(dir) {
  if (dir !== undefined) currentDir = dir;
  try {
    const r = await api("/api/files?path=" + encodeURIComponent(currentDir));
    $("file-path").textContent = "/" + (r.dir || "(root)");
    const list = $("file-list");
    if (r.files.length === 0) {
      list.innerHTML = '<small style="color:var(--muted)">(empty directory)</small>';
      return;
    }
    list.innerHTML = r.files.map(f => {
      const size = f.isDir ? "dir" : formatSize(f.size);
      const mtime = f.mtime ? new Date(f.mtime).toLocaleString() : "";
      const click = f.isDir ? \`onclick="filesBrowse('\${escPath(r.dir, f.name)}')"\` : "";
      const dl = !f.isDir ? \`<a href="/api/files/download?path=\${escPath(r.dir, f.name)}" style="color:var(--accent); text-decoration:none; font-size:11px">↓</a>\` : "";
      const rm = !f.isDir ? \`<button class="danger" style="padding:2px 6px; font-size:11px" onclick="delFile('\${escPath(r.dir, f.name)}','\${f.name}')">×</button>\` : "";
      return \`<div style="display:flex; align-items:center; padding:3px 0; border-bottom:1px solid #1e293b">
        <span \${click} style="cursor:\${f.isDir?'pointer':'default'}; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          \${f.isDir ? '📁 ' : '📄 '}\${f.name}
        </span>
        <span style="width:60px; text-align:right; color:var(--muted); font-size:11px">\${size}</span>
        <span style="width:140px; text-align:right; color:var(--muted); font-size:11px">\${mtime}</span>
        <span style="width:30px; text-align:center">\${dl}\${rm}</span>
      </div>\`;
    }).join("");
  } catch (e) { $("file-list").textContent = "error: " + e.message; }
}

function escPath(dir, name) {
  const p = dir ? dir + "/" + name : name;
  return p.replace(/'/g, "\\'");
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

async function delFile(p, name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try { await api("/api/files?path=" + encodeURIComponent(p), { method: "DELETE" }); toast("deleted " + name); filesBrowse(); } catch {}
}

async function uploadFile(input) {
  const files = input.files;
  if (!files.length) return;
  for (const file of files) {
    const fd = new FormData();
    fd.append("path", currentDir);
    fd.append("file", file);
    try {
      const r = await fetch("/api/files/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) { toast(d.error || "upload failed", true); continue; }
      toast("uploaded " + file.name);
    } catch (e) { toast("upload failed: " + e.message, true); }
  }
  input.value = "";
  filesBrowse();
}

setInterval(() => {
  const base = botUptimeBase || startedAt;
  const sec = Math.floor((Date.now() - base) / 1000);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  $("uptime").textContent = \`uptime: \${h ? h + "h " : ""}\${m}m \${s}s\`;
}, 1000);

setInterval(() => {
  // Don't hammer the probes while the tab is hidden or an env edit is open.
  if (document.hidden) return;
  refreshStatus().catch(() => {});
}, 10000);

// Follow toggle: reflect server state, persist changes.
async function syncFollowChk() {
  try {
    const d = await (await fetch("/api/session")).json();
    $("follow-chk").checked = !!d.follow;
  } catch { /* keep current */ }
}
$("follow-chk").onchange = async (e) => {
  try {
    await api("/api/session", { method: "POST", body: JSON.stringify({ follow: e.target.checked }) });
    toast(e.target.checked ? "webui follows telegram from now on" : "stopped following telegram");
  } catch {
    e.target.checked = !e.target.checked;
  }
};
syncFollowChk();

refreshStatus();
refreshPatterns();
filesBrowse();
loadModels();
loadSecrets();
</script>
</body>
</html>
`;
}

export function buildChatHtml(config: UiConfig, sttLabel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grandpa-bob</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --fg:#e2e8f0; --muted:#94a3b8; --accent:#3b82f6; --green:#10b981; --red:#ef4444; --border:#334155; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100dvh; }
  header { display: flex; align-items: baseline; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: #0b1224; }
  header h1 { font-size: 17px; margin: 0; }
  header .sub { color: var(--muted); font-size: 12px; }
  header nav { margin-left: auto; }
  header nav a { color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 600; }
  #pattern-sel { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; padding: 3px 6px; }
  #health-dots { display: inline-flex; align-items: center; gap: 9px; margin-left: 4px; }
  #health-dots .hdot { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--muted); }
  #health-dots .hdot i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--muted); }
  #health-dots .hdot.up i { background: var(--green); }
  #health-dots .hdot.down i { background: var(--red); }
  #session-id-wrap { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; }
  #session-id-wrap[hidden] { display: none; }
  #session-id { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 3px 7px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #session-id-copy { background: #475569; font-size: 11px; padding: 4px 8px; }
  #session-bar { display: flex; gap: 8px; align-items: center; padding: 8px 16px; background: #263449; border-bottom: 1px solid var(--border); font-size: 13px; }
  #session-bar select { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; font-size: 13px; padding: 4px 8px; max-width: 340px; }
  #input:disabled, #send-btn:disabled, #mic-btn:disabled, #file-btn:disabled { opacity: 0.4; }
  main { flex: 1; overflow-y: auto; padding: 16px; }
  .inner { max-width: 860px; margin: 0 auto; }
  .empty { color: var(--muted); text-align: center; margin-top: 18vh; font-size: 15px; }
  .turn { margin-bottom: 20px; }
  .msg-user { display: flex; justify-content: flex-end; margin: 6px 0; }
  .msg-user .bubble { background: #1d4ed8; color: #fff; padding: 8px 14px; border-radius: 14px 14px 4px 14px; max-width: 85%; white-space: pre-wrap; word-break: break-word; }
  .msg-user .qtag { align-self: center; margin-right: 8px; font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; }
  .heard { color: var(--muted); font-size: 12.5px; font-style: italic; margin: 6px 2px; }
  .steps { background: var(--card); border: 1px solid var(--border); border-radius: 8px; margin: 8px 0; }
  .steps > summary { cursor: pointer; padding: 8px 12px; color: var(--muted); font-size: 12px; display: flex; gap: 8px; align-items: center; list-style: none; }
  .steps > summary::-webkit-details-marker { display: none; }
  .steps .count { margin-left: auto; font-family: ui-monospace, monospace; }
  .steps .copy-log { flex: none; font: inherit; font-size: 11px; color: var(--muted); background: transparent; border: 1px solid var(--border); border-radius: 5px; padding: 1px 8px; cursor: pointer; }
  .steps .copy-log:hover { color: var(--fg); border-color: var(--accent); }
  .spinner { width: 12px; height: 12px; flex: none; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .step-list { margin: 0; padding: 4px 12px 10px; list-style: none; border-top: 1px solid var(--border); }
  .step { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .step details > summary { cursor: pointer; padding: 3px 0; display: flex; gap: 8px; align-items: baseline; list-style: none; }
  .step details > summary::-webkit-details-marker { display: none; }
  .badge { flex: none; min-width: 58px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; background: #334155; color: var(--fg); text-transform: uppercase; }
  .step-id { color: #94a3b8; font-size: 11px; flex: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spath { color: #64748b; font-size: 11px; flex: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stext { color: #cbd5e1; word-break: break-word; }
  .step pre { margin: 2px 0 8px 66px; padding: 8px; background: #0b1224; border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all; color: #94a3b8; max-height: 240px; overflow: auto; }
  .k-llm .badge { background: #155e75; }
  .k-tool .badge { background: #713f12; }
  .k-result .badge { background: #14532d; }
  .k-emit .badge { background: #065f46; color: #6ee7b7; }
  .k-emit .stext { color: #a7f3d0; font-weight: 600; }
  .k-human .badge { background: #374151; color: #fff; }
  .k-flow .badge { background: #1e3a8a; }
  .k-hook .badge { background: #5b21b6; }
  .k-check .badge { background: #4a044e; }
  .k-loop .badge { background: #4a044e; }
  .k-memory .badge { background: #312e81; }
  .k-err .badge { background: #7f1d1d; }
  .k-err .stext { color: #fca5a5; }
  .k-dim .badge { background: #1f2937; color: var(--muted); }
  .k-dim .stext { color: var(--muted); }
  .k-map .badge { background: #3730a3; }
  .k-map .stext { color: #c7d2fe; }
  .k-map-item .badge { background: #1e1b4b; }
  .step-list.nested { border-top: none; padding: 0 0 6px 12px; }
  .msg-answer { display: flex; gap: 8px; margin: 8px 0; align-items: flex-start; }
  .msg-answer .who { flex: none; font-size: 12px; font-weight: 700; color: var(--green); padding-top: 10px; }
  .msg-answer .bubble { background: var(--card); border: 1px solid var(--border); border-radius: 4px 14px 14px 14px; padding: 10px 14px; max-width: 90%; white-space: pre-wrap; word-break: break-word; }
  .msg-answer[data-level="machine"] .bubble { background: transparent; border-style: dashed; color: var(--muted); font: 12px ui-monospace, monospace; }
  .msg-answer[data-level="machine"] .who { color: var(--muted); font-weight: 600; }
  body.hide-machine .msg-answer[data-level="machine"] { display: none; }
  .emit-btns { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 6px 34px; }
  .emit-btn { background: var(--accent); color: #fff; border: none; padding: 7px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .emit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .msg-error { color: #fca5a5; border: 1px solid #7f1d1d; background: #450a0a; border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-size: 13px; white-space: pre-wrap; }
  footer { border-top: 1px solid var(--border); background: #0b1224; padding: 10px 16px 12px; }
  .input-row { display: flex; gap: 8px; max-width: 860px; margin: 0 auto; align-items: flex-end; }
  textarea { flex: 1; resize: none; padding: 10px 12px; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; font: 15px system-ui; max-height: 140px; }
  textarea:focus { outline: none; border-color: var(--accent); }
  button { background: var(--accent); color: #fff; border: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button.secondary { background: #475569; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  #mic-btn { background: #475569; font-size: 16px; padding: 8px 14px; }
  #mic-btn.recording { background: var(--red); animation: pulse 1.2s ease-in-out infinite; }
  #file-btn { background: #475569; font-size: 15px; padding: 8px 14px; }
  @keyframes pulse { 50% { opacity: 0.6; } }
  #mic-timer { align-self: center; font-size: 12px; color: var(--muted); min-width: 28px; }
  .file-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
  .file-card .fc-head { display: flex; gap: 8px; align-items: center; font-size: 13px; }
  .file-card .fc-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-card .fc-status { margin-left: auto; color: var(--muted); font-size: 12px; flex: none; }
  .file-card .fc-text { margin-top: 6px; font-size: 13.5px; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; }
  .file-card.done .fc-text { color: var(--fg); }
  .file-card.err { border-color: #7f1d1d; }
  .file-card.err .fc-text { color: #fca5a5; }
  .foot-note { max-width: 860px; margin: 6px auto 0; font-size: 11px; color: #64748b; display: flex; gap: 10px; }
  .foot-note .right { margin-left: auto; }
  .toast { position: fixed; top: 16px; right: 16px; background: var(--green); color: #fff; padding: 10px 16px; border-radius: 6px; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 10; }
  .toast.show { opacity: 1; }
  .toast.err { background: var(--red); }
  #tree-btn { background: #475569; font-size: 12px; padding: 4px 10px; }
  #tg-btn { background: #475569; font-size: 12px; padding: 4px 10px; }
  #tg-btn:disabled { opacity: 0.4; }
  #internals-btn { background: #475569; font-size: 12px; padding: 4px 10px; }
  #internals-btn.on { background: #2563eb; color: #fff; }
  #machine-btn { background: #475569; font-size: 12px; padding: 4px 10px; }
  #machine-btn.on { background: #2563eb; color: #fff; }
  body:not(.show-internals) .step.k-internals { display: none; }
  #tree-panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(430px, 92vw); background: #0b1224; border-left: 1px solid var(--border); transform: translateX(105%); transition: transform 0.22s ease; z-index: 21; display: flex; flex-direction: column; }
  #tree-panel.open { transform: none; box-shadow: 0 0 40px rgba(0,0,0,0.5); }
  .tp-head-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .tp-head-row h2 { font-size: 14px; margin: 0; }
  .tp-head-row .tp-cur { color: var(--muted); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #tree-close { background: #475569; padding: 4px 10px; font-size: 12px; }
  #tree-body { flex: 1; overflow: auto; padding: 10px 12px; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tp-meta { color: #64748b; font-size: 11px; margin: 4px 0 8px; white-space: pre-wrap; }
  .tp-children { list-style: none; margin: 0; padding-left: 14px; border-left: 1px dashed #334155; }
  .tp-node { margin: 2px 0; border-radius: 6px; }
  .tp-node > details > summary, .tp-row { display: flex; gap: 6px; align-items: baseline; padding: 2px 4px; border-radius: 5px; list-style: none; }
  .tp-node > details > summary { cursor: pointer; }
  .tp-node > details > summary::-webkit-details-marker { display: none; }
  .tp-badge { flex: none; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; background: #334155; padding: 1px 5px; border-radius: 4px; min-width: 52px; text-align: center; }
  .tp-name { color: #e2e8f0; font-weight: 600; }
  .tp-gate { color: #94a3b8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tp-body { margin: 2px 0 6px 8px; }
  .tp-info { display: flex; gap: 6px; margin: 2px 0; }
  .tp-k { flex: none; color: #64748b; font-size: 10px; text-transform: uppercase; min-width: 48px; }
  .tp-v { margin: 0; color: #94a3b8; font-size: 11px; white-space: pre-wrap; word-break: break-word; flex: 1; max-height: 160px; overflow: auto; }
  .tp-node.k-prompt .tp-badge { background: #155e75; }
  .tp-node.k-human .tp-badge { background: #374151; color: #fff; }
  .tp-node.k-emit .tp-badge { background: #065f46; color: #6ee7b7; }
  .tp-node.k-branch .tp-badge, .tp-node.k-map .tp-badge { background: #1e3a8a; }
  .tp-node.k-until .tp-badge, .tp-node.k-check .tp-badge { background: #4a044e; }
  .tp-node.k-memory .tp-badge, .tp-node.k-memoryUpdate .tp-badge { background: #312e81; }
  .tp-node.k-call .tp-badge { background: #713f12; }
  .tp-node.tp-visited .tp-badge { background: #14532d; }
  .tp-node.tp-active { background: rgba(30,58,138,0.35); outline: 1px solid var(--accent); }
  .tp-node.tp-active > details > summary .tp-badge, .tp-node.tp-active > .tp-row .tp-badge { background: var(--accent); }
  .tp-empty { color: var(--muted); }
  #tree-body pre.tp-spec-body { white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd5e1; margin: 0; padding: 8px 4px; }
  .tp-mem-btn { text-align: left; background: none; border: none; padding: 0; font: inherit; cursor: pointer; color: #a5b4fc; }
  .tp-mem-btn:hover { text-decoration: underline; }
  #mem-popup { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; background: rgba(2,6,23,0.72); }
  #mem-popup .mem-box { width: min(720px, 94vw); max-height: 84vh; display: flex; flex-direction: column; background: #0b1224; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  #mem-popup .mem-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  #mem-popup .mem-head h3 { font-size: 13px; margin: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #mem-popup .mem-head button { background: #475569; padding: 3px 10px; font-size: 12px; border: 0; border-radius: 5px; color: #e2e8f0; cursor: pointer; }
  #mem-popup .mem-body { flex: 1; overflow: auto; padding: 12px 14px; }
  #mem-popup pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd5e1; }
</style>
</head>
<body>
<header>
  <h1>grandpa-bob</h1>
  <span class="sub">${sttLabel}</span>
  <span id="health-dots" title="service health — green up, red down, grey not configured"></span>
  <span id="session-id-wrap" hidden title="active session id">
    <span id="session-id"></span>
    <button id="session-id-copy" title="copy session id">copy</button>
  </span>
  <select id="pattern-sel" title="tree to run (patterns/*.mjs or app/*/tree.mjs)"></select>
  <select id="ref-sel" title="version used by NEW sessions (running sessions keep their pinned version)"></select>
  <button id="tree-btn" title="show the structure of the active tree">tree</button>
  <button id="tg-btn" title="send this session's transcript to your telegram chat">✈ telegram</button>
  <button id="internals-btn" title="show runtime bookkeeping steps (record, scope)">internals</button>
  <button id="machine-btn" title="show or hide machine narration (engine &lt;&lt;! notes)">machine</button>
  <nav><a href="/settings">settings</a></nav>
</header>
<div id="session-bar" hidden>
  <span>Select a session to resume:</span>
  <select id="session-sel"></select>
  <button id="session-resume">resume</button>
  <button id="session-new" class="secondary">new chat</button>
</div>
<main id="main"><div class="inner" id="conversation"></div></main>
<footer>
  <div class="input-row">
    <button id="mic-btn" title="hold a conversation by voice">&#127908;</button>
    <span id="mic-timer"></span>
    <button id="file-btn" title="attach a file">&#128206;</button>
    <input id="file-input" type="file" style="display:none">
    <textarea id="input" rows="1" placeholder="type a message&hellip;" enterkeyhint="send"></textarea>
    <button id="send-btn">Send</button>
  </div>
  <div class="foot-note">
    <span>Enter to send &middot; Shift+Enter for a new line</span>
    <span class="right"><button id="clear-btn" class="secondary" style="padding:2px 10px;font-size:12px">clear conversation</button></span>
  </div>
</footer>
<div id="toast" class="toast"></div>
<aside id="tree-panel" aria-label="tree structure">
  <div class="tp-head-row">
    <h2>tree</h2>
    <span class="tp-cur" id="tp-pattern"></span>
    <button id="tp-snapshot" class="secondary" title="snapshot the draft into the next version">snapshot</button>
    <button id="tp-promote" class="secondary" title="promote the selected version to production">promote</button>
    <button id="tp-spec" class="secondary" title="show this version's paired .spec.md">spec</button>
    <button id="tree-close">close</button>
  </div>
  <div id="tree-body"><div class="tp-empty">loading&hellip;</div></div>
</aside>
<script>
const $ = (id) => document.getElementById(id);
const conv = $("conversation");
const mainEl = $("main");
const blocks = new Map(); // turnId -> live turn block
// Turn ids already present in the transcript. Unlike blocks (which only
// tracks RUNNING turns and drops each id at turn_end), this set is never
// pruned until the transcript is cleared, so a re-sync — SSE reconnect or
// the follow poll — never re-appends a finished turn as a second copy.
const rendered = new Set();

function toast(msg, isErr, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => (t.className = "toast" + (isErr ? " err" : "")), ms || (isErr ? 6000 : 3000));
}

function short(s, n) {
  if (s === null || s === undefined) return "";
  s = String(s).replace(/\\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "\\u2026" : s;
}
function jshort(v, n) { return short(typeof v === "string" ? v : JSON.stringify(v), n ?? 120); }

function maybeScroll(force) {
  const nearBottom = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 140;
  if (force || nearBottom) mainEl.scrollTop = mainEl.scrollHeight;
}

function hideEmpty() {
  const hint = $("empty-hint");
  if (hint) hint.remove();
}
function showEmpty() {
  if (conv.querySelector(".turn, .msg-user, .heard")) return;
  const hint = document.createElement("div");
  hint.className = "empty";
  hint.id = "empty-hint";
  hint.textContent = "Say something \\u2014 type it, or tap the mic. Every step the tree takes appears under your message.";
  conv.appendChild(hint);
}

/** Provenance: the memory slots an event read, if the run log recorded them. */
function readsNote(c) {
  return Array.isArray(c?.reads) && c.reads.length
    ? "  [reads: " + c.reads.map((r) => r.name ?? "?").join(", ") + "]"
    : "";
}

function describeEvent(ev) {
  const c = ev.content || {};
  const iter = ev.iteration > 1 ? " #" + ev.iteration : "";
  switch (ev.kind) {
    case "human":
      return { badge: "human", cls: "k-human", text: (c.child ?? "?") + " \\u2014 paused, waiting for input" };
    case "llm_call": {
      let t = (c.model ?? "?") + (c.round > 1 ? " round " + c.round : "") + iter;
      if (c.messages?.count) t += " (input: " + c.messages.count + " msgs)";
      if (Array.isArray(c.toolCalls) && c.toolCalls.length) {
        t += " \\u2192 tool calls: " + c.toolCalls.map((tc) => tc.name ?? tc.function?.name ?? "?").join(", ");
      } else if (c.content) {
        t += " \\u2192 " + jshort(c.content, 160);
      }
      return { badge: "llm", cls: "k-llm", text: t + readsNote(c) };
    }
    case "llm_error":
      return { badge: "llm-err", cls: "k-err", text: (c.model ?? "?") + " failed: " + jshort(c.error, 160) };
    case "tool_call":
      return {
        badge: "tool", cls: "k-tool",
        text: (c.tool ?? "?") + (c.args ? "(" + jshort(JSON.stringify(c.args), 80) + ")" : "") +
          (c.result !== undefined ? " \\u2192 " + jshort(c.result, 100) : ""),
      };
    case "tool_result":
      return {
        badge: c.isError ? "error" : "result", cls: c.isError ? "k-err" : "k-result",
        text: (c.tool ?? "?") + " \\u2192 " + jshort(c.result, 160),
      };
    case "tool_error":
      return { badge: "error", cls: "k-err", text: (c.tool ?? "?") + " failed: " + jshort(c.error, 160) };
    case "hook": {
      const on = [c.phase, c.tool].filter(Boolean).join(" ");
      return {
        badge: "hook",
        cls: "k-hook",
        text: (c.trigger ?? "?") + " " + (c.hook ?? "?") + (on ? " (on " + on + ")" : ""),
      };
    }
    case "check":
      return { badge: "check", cls: c.pass ? "k-check" : "k-err", text: (c.child ?? "?") + (c.pass ? " \\u2014 pass" : " \\u2014 FAIL: " + jshort(c.feedback, 120)) };
    case "until":
      return { badge: "until", cls: c.pass ? "k-check" : "k-loop", text: (c.child ?? "?") + (c.pass ? " \\u2014 done" : " \\u2014 loop: " + jshort(c.feedback, 120)) };
    case "gate":
      return { badge: "gate", cls: "k-flow", text: (c.child ?? "?") + " \\u2192 " + jshort(c.result, 80) };
    case "flow":
      return {
        badge: "flow", cls: "k-flow",
        text: (c.type ?? "?") + (c.n ? "(" + c.n + ")" : "") + (c.child ? " from " + c.child : "") + (c.used ? " (" + c.used + "/" + (c.max ?? "?") + ")" : ""),
      };
    case "memory":
      return { badge: "memory", cls: "k-memory", text: (c.child ?? "?") + " = " + jshort(c.value, 100) + readsNote(c) };
    case "emit":
      return { badge: "emit", cls: "k-emit", text: jshort(c.value, 200) };
    case "record":
      // Memory writes are record rows with an op flag; they stay visible.
      if (c.op === "memory" || c.op === "memoryUpdate") {
        return { badge: "memory", cls: "k-memory", text: (c.child ?? "?") + " = " + jshort(c.value, 100) + readsNote(c) };
      }
      return { badge: "record", cls: "k-dim", internals: true, text: (c.child ?? "?") + " = " + jshort(c.value, 80) };
    case "scope_init":
      return { badge: "scope", cls: "k-dim", internals: true, text: "#" + c.scopeId + (c.parentScopeId != null ? " (parent #" + c.parentScopeId + ")" : "") };
    case "map":
      return { badge: "map", cls: "k-dim", text: (c.child ?? "?") + " \\u2014 " + c.count + " item(s)" };
    case "map_item":
      return { badge: "map", cls: "k-dim", text: (c.child ?? "?") + "[" + c.index + "] = " + jshort(c.value, 80) };
    case "return":
      return { badge: "return", cls: "k-dim", text: (c.child ?? "?") + " = " + jshort(c.value, 80) };
    default:
      return { badge: ev.kind, cls: "k-dim", text: jshort(JSON.stringify(c), 120) };
  }
}

function collectStepLines(list, depth, lines) {
  for (const li of Array.from(list.children)) {
    if (!li.classList || !li.classList.contains("step")) continue;
    const sum = li.querySelector(":scope > details > summary");
    if (sum) {
      const badge = sum.querySelector(".badge")?.textContent ?? "?";
      const id = sum.querySelector(".step-id")?.textContent ?? "";
      const path = sum.querySelector(".spath")?.textContent ?? "";
      const text = sum.querySelector(".stext")?.textContent ?? "";
      lines.push("    ".repeat(depth) + [badge, id, path, text].filter(Boolean).join(" "));
    }
    const pre = li.querySelector(":scope > details > pre");
    if (pre?.textContent) {
      lines.push(...pre.textContent.split("\\n").map((line) => "    ".repeat(depth + 1) + line));
    }
    const nested = li.querySelector(":scope > details > .step-list");
    if (nested) collectStepLines(nested, depth + 1, lines);
    lines.push("");
  }
}

function turnLogText(turn) {
  const lines = [];
  const input = turn.querySelector(".msg-user .bubble");
  if (input) lines.push("[user] " + input.textContent, "");
  const list = turn.querySelector(".step-list");
  if (list) collectStepLines(list, 0, lines);
  const answer = turn.querySelector(".msg-answer .bubble");
  if (answer) lines.push("[bob] " + answer.textContent);
  const err = turn.querySelector(".msg-error");
  if (err) lines.push("[error] " + err.textContent);
  return lines.join("\\n").trim();
}

async function copyTurnLog(turn, btn) {
  const text = turnLogText(turn);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = "copied";
  setTimeout(() => (btn.textContent = old), 1200);
}

function startTurn(turnId, input) {
  // A re-sync may render a turn the SSE turn_start then repeats — and a turn
  // that already ENDED must never be appended a second time by a later
  // re-sync (its block left the live map at turn_end). Drop the optimistic
  // bubble the send added so it cannot linger beside the rendered turn.
  if (blocks.has(turnId) || rendered.has(turnId)) {
    conv.querySelector('.msg-user.pending[data-turnid="' + turnId + '"]')?.remove();
    return;
  }
  hideEmpty();
  // Only the newest turn's buttons stay live: an older pause's keyboard
  // must not accept a tap aimed at the current one.
  for (const b of conv.querySelectorAll(".emit-btn")) b.disabled = true;
  const pending = conv.querySelector('.msg-user.pending[data-turnid="' + turnId + '"]');
  const turn = document.createElement("div");
  turn.className = "turn";

  const userMsg = document.createElement("div");
  userMsg.className = "msg-user";
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.textContent = input;
  userMsg.appendChild(bub);
  turn.appendChild(userMsg);

  const steps = document.createElement("details");
  steps.className = "steps";
  steps.open = true;
  const sum = document.createElement("summary");
  const spin = document.createElement("span");
  spin.className = "spinner";
  const lab = document.createElement("span");
  lab.textContent = "running tree\\u2026";
  const cnt = document.createElement("span");
  cnt.className = "count";
  const copy = document.createElement("button");
  copy.className = "copy-log";
  copy.type = "button";
  copy.textContent = "copy";
  copy.title = "Copy the full conversation log for this turn";
  copy.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyTurnLog(turn, copy);
  });
  sum.append(spin, lab, cnt, copy);
  const list = document.createElement("ol");
  list.className = "step-list";
  steps.append(sum, list);
  turn.appendChild(steps);

  if (pending) pending.replaceWith(turn);
  else conv.appendChild(turn);

  const block = { turn, list, spin, lab, cnt, answerBubs: [] };
  blocks.set(turnId, block);
  rendered.add(turnId);
  maybeScroll(true);
  return block;
}

function renderStepLi(ev) {
  const d = describeEvent(ev);
  const li = document.createElement("li");
  li.className = "step " + d.cls;
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = d.badge;
  const content = ev.content || {};
  const identity = content.child ?? content.name ??
    (content.scopeId != null ? "#" + content.scopeId : "");
  const id = document.createElement("span");
  id.className = "step-id";
  id.textContent = identity ? String(identity) : "";
  const sp = document.createElement("span");
  sp.className = "spath";
  sp.textContent = ev.branch_path ? "[" + ev.branch_path + "]" : "";
  const txt = document.createElement("span");
  txt.className = "stext";
  txt.textContent = d.text;
  sum.append(badge, id, sp, txt);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(ev.content, null, 2);
  det.append(sum, pre);
  li.appendChild(det);
  if (d.internals) li.classList.add("k-internals");
  return li;
}

// ---- map runs ----------------------------------------------------------
// A .map() runs its subtree once per item, so an import logs thousands of
// rows. Each map run collapses into one block; its items become one row each
// (all of the item's events live in that row's details).

// Walk a scope's parents (scope_init events) looking for an ancestor.
function inScope(block, scopeId, ancestorId) {
  if (scopeId == null || ancestorId == null) return false;
  let s = scopeId;
  for (let i = 0; i < 64; i++) {
    if (s === ancestorId) return true;
    s = block.scopeParent.get(s);
    if (s == null) return false;
  }
  return false;
}

function mapItemLi(events, item) {
  const li = document.createElement("li");
  li.className = "step k-map-item";
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  const badge = document.createElement("span");
  badge.className = "badge";
  const tool = events.find((e) => e.kind === "tool_call");
  badge.textContent = tool?.content?.tool ? String(tool.content.tool) : "map";
  const id = document.createElement("span");
  id.className = "step-id";
  id.textContent = "[" + (item.content?.index ?? "?") + "]";
  const txt = document.createElement("span");
  txt.className = "stext";
  txt.textContent = jshort(item.content?.value, 120);
  sum.append(badge, id, txt);
  const pre = document.createElement("pre");
  pre.textContent = [...events, item]
    .map((e) => "// " + e.kind + (e.branch_path ? " [" + e.branch_path + "]" : "") +
      "\\n" + JSON.stringify(e.content, null, 2))
    .join("\\n\\n");
  det.append(sum, pre);
  li.appendChild(det);
  return li;
}

function openMapGroup(block, scopeId, child) {
  const li = document.createElement("li");
  li.className = "step k-map";
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "map";
  const id = document.createElement("span");
  id.className = "step-id";
  id.textContent = child;
  const txt = document.createElement("span");
  txt.className = "stext";
  txt.textContent = "running\\u2026";
  sum.append(badge, id, txt);
  const body = document.createElement("ol");
  body.className = "step-list nested";
  det.append(sum, body);
  li.appendChild(det);
  block.list.appendChild(li);
  const group = { scopeId, child, body, txt, buffer: [], count: 0 };
  block.maps.push(group);
  return group;
}

function flushMapItem(block, group, item) {
  group.body.appendChild(mapItemLi(group.buffer, item));
  group.buffer = [];
  group.count++;
  group.txt.textContent = group.count + " item(s)";
  updateCount(block);
  maybeScroll(false);
}

function finishMap(block, group, ev) {
  for (const e of group.buffer) group.body.appendChild(renderStepLi(e));
  group.buffer = [];
  group.txt.textContent = group.count + " item(s)";
  if (block.maps[block.maps.length - 1] === group) block.maps.pop();
  updateCount(block);
  maybeScroll(false);
}

// Map items stream their events before the closing map/map_item event, so the
// first item's rows were already rendered. Move them into the group buffer.
function adoptRendered(block, group) {
  const adopted = [];
  for (let i = block.rendered.length - 1; i >= 0; i--) {
    const r = block.rendered[i];
    if (!inScope(block, r.ev.scope_id, group.scopeId)) break;
    r.li.remove();
    adopted.push(r.ev);
    block.rendered.splice(i, 1);
  }
  adopted.reverse();
  group.buffer = adopted.concat(group.buffer);
}

function addStep(turnId, ev) {
  const block = blocks.get(turnId);
  if (!block) return;
  if (!block.scopeParent) block.scopeParent = new Map();
  if (!block.rendered) block.rendered = [];
  if (!block.maps) block.maps = [];

  if (ev.kind === "scope_init" && ev.content && ev.content.scopeId != null) {
    block.scopeParent.set(ev.content.scopeId, ev.content.parentScopeId ?? null);
  }

  const top = block.maps[block.maps.length - 1];
  // Events persisted before scope_id was logged have none; render them flat
  // rather than grouping them half-way.
  const ownMapEvent = top && ev.scope_id != null && ev.scope_id === top.scopeId;

  if (ownMapEvent && ev.kind === "map" && ev.content?.child === top.child) {
    finishMap(block, top, ev);
    return;
  }
  if (ownMapEvent && ev.kind === "map_item") {
    flushMapItem(block, top, ev);
    return;
  }
  if (top && inScope(block, ev.scope_id, top.scopeId)) {
    top.buffer.push(ev);
    return;
  }
  if (ev.kind === "map_item" && ev.scope_id != null) {
    // First item of a map run: open the block, adopt its already-rendered
    // events, then add its row.
    const group = openMapGroup(block, ev.scope_id, ev.content?.child ?? "?");
    adoptRendered(block, group);
    flushMapItem(block, group, ev);
    return;
  }
  if (ev.kind === "map" && ev.scope_id != null) {
    const group = openMapGroup(block, ev.scope_id, ev.content?.child ?? "?");
    adoptRendered(block, group);
    finishMap(block, group, ev);
    return;
  }

  const li = renderStepLi(ev);
  block.list.appendChild(li);
  block.rendered.push({ ev, li });
  updateCount(block);
  maybeScroll(false);
}

function renderEmitButtons(block, buttons) {
  if (block.emitBtns) { block.emitBtns.remove(); block.emitBtns = null; }
  if (!buttons || !buttons.length) return;
  const wrap = document.createElement("div");
  wrap.className = "emit-btns";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emit-btn";
    btn.textContent = b.label;
    btn.addEventListener("click", () => {
      // One-shot: a tap sends the value as a reply, then the group goes inert.
      for (const el of wrap.querySelectorAll("button")) el.disabled = true;
      sendText(b.value);
    });
    wrap.appendChild(btn);
  }
  // Buttons live outside the answer bubble: endTurn settles the bubble's
  // text and must never wipe the keyboard.
  const answers = block.turn.querySelectorAll(".msg-answer");
  const ans = answers.length ? answers[answers.length - 1] : null;
  if (ans) ans.after(wrap);
  else block.turn.appendChild(wrap);
  block.emitBtns = wrap;
}

function appendAnswer(block, text, withWho, level) {
  const ans = document.createElement("div");
  ans.className = "msg-answer";
  if (level) ans.dataset.level = level;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = withWho ? "bob" : "";
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.textContent = text;
  ans.append(who, bub);
  block.turn.appendChild(ans);
  block.answerBubs.push(bub);
  block.answerBub = bub;
  return bub;
}

function emitToTurn(turnId, text, buttons, level) {
  const block = blocks.get(turnId);
  if (!block) return;
  // One Emit = one bubble; the "bob" label rides the first only.
  if (text) appendAnswer(block, text, (block.answerBubs || []).length === 0, level);
  if (buttons) renderEmitButtons(block, buttons);
  maybeScroll(false);
}

function endTurn(turnId, status, error, output, buttons, emits, levels) {
  const block = blocks.get(turnId);
  if (!block) return;
  blocks.delete(turnId);
  block.spin.remove();
  block.lab.textContent = status === "error" ? "tree failed" : "tree steps";
  if (status === "error") {
    const errEl = document.createElement("div");
    errEl.className = "msg-error";
    errEl.textContent = "Something went wrong: " + (error || "unknown error");
    block.turn.appendChild(errEl);
  }
  // The authoritative reply: one bubble per emit. Older records (and remote
  // turns) carry only the joined output, so fall back to a single bubble.
  const texts = Array.isArray(emits) && emits.length ? emits : (output ? [output] : []);
  const lvls = Array.isArray(levels) ? levels : [];
  if (texts.length) {
    const streamed = block.answerBubs || [];
    const matches = streamed.length === texts.length &&
      streamed.every((b, i) => b.textContent === texts[i]);
    if (!matches) {
      // A replayed turn, or a rewind that changed the emits — drop what
      // streamed and render the final list.
      for (const b of streamed) b.closest(".msg-answer")?.remove();
      block.answerBubs = [];
      for (let i = 0; i < texts.length; i++) appendAnswer(block, texts[i], i === 0, lvls[i]);
    }
  }
  // Replay renders the settled buttons once; a live turn already streamed
  // them (and may have disabled them after a tap).
  if (buttons && !block.emitBtns) renderEmitButtons(block, buttons);
  // Keep the keyboard under the bubble even when the bubble only appears here.
  if (block.emitBtns) block.turn.appendChild(block.emitBtns);
  maybeScroll(true);
}

function addPending(turnId, text, queued) {
  const wrap = document.createElement("div");
  wrap.className = "msg-user pending";
  wrap.dataset.turnid = turnId;
  const tag = document.createElement("span");
  tag.className = "qtag";
  tag.textContent = queued ? "queued" : "sending\\u2026";
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.textContent = text;
  wrap.append(tag, bub);
  conv.appendChild(wrap);
  maybeScroll(true);
}

async function sendText(text) {
  if (!sessionActive) { toast("select or start a session first", true); return; }
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "send failed", true); return; }
    // Show the message immediately — do not wait for the SSE turn_start. The
    // bubble is replaced in place when the turn renders (startTurn), or removed
    // if the turn was already rendered by a re-sync.
    if (d.turnId) addPending(d.turnId, text, d.queued);
    hideEmpty();
  } catch (e) {
    toast("send failed: " + e.message, true);
  }
}

async function uploadAttachment(file) {
  const caption = input.value.trim();
  const fd = new FormData();
  fd.append("file", file);
  if (caption) fd.append("caption", caption);
  try {
    const r = await fetch("/api/chat/upload", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "upload failed", true); return; }
    const display = caption ? caption + "\\n[attached: " + file.name + "]" : "[attached: " + file.name + "]";
    if (d.turnId) addPending(d.turnId, display, d.queued);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    hideEmpty();
  } catch (e) {
    toast("upload failed: " + e.message, true);
  }
}

// ---- input box ----
const input = $("input");
$("send-btn").onclick = doSend;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
});
function doSend() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  sendText(text);
}

// ---- voice input (MediaRecorder -> /api/transcribe -> auto-send) ----
const micBtn = $("mic-btn");
const micTimer = $("mic-timer");
const canMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
if (!canMic) {
  micBtn.disabled = true;
  micBtn.title = "voice input needs a secure context (localhost or https)";
}
let rec = null, recStream = null, recChunks = [], recInt = null, recSecs = 0;

micBtn.onclick = async () => {
  if (rec && rec.state === "recording") { rec.stop(); return; }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("microphone unavailable: " + e.message, true, 8000);
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
    .find((t) => MediaRecorder.isTypeSupported(t)) || "";
  rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = onRecStop;
  rec.start();
  recSecs = 0;
  micBtn.classList.add("recording");
  micTimer.textContent = "0s";
  recInt = setInterval(() => { recSecs++; micTimer.textContent = recSecs + "s"; }, 1000);
};

async function onRecStop() {
  clearInterval(recInt);
  micBtn.classList.remove("recording");
  micTimer.textContent = "";
  if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
  const mimeType = rec.mimeType || "audio/webm";
  const blob = new Blob(recChunks, { type: mimeType });
  rec = null;
  if (!blob.size) return;
  if (recSecs < 1) { toast("recording too short", true); return; }
  toast("transcribing\\u2026", false, 2000);
  const fd = new FormData();
  fd.append("file", blob, "voice" + (mimeType.includes("mp4") ? ".mp4" : ".webm"));
  try {
    const r = await fetch("/api/transcribe", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "transcription failed", true, 8000); return; }
    hideEmpty();
    const heard = document.createElement("div");
    heard.className = "heard";
    heard.textContent = 'heard: "' + d.text + '"';
    conv.appendChild(heard);
    maybeScroll(true);
    sendText(d.text);
  } catch (e) {
    toast("transcription failed: " + e.message, true, 8000);
  }
}

// ---- audio file upload with streaming transcription ----
$("file-btn").onclick = () => $("file-input").click();
$("file-input").addEventListener("change", () => {
  const file = $("file-input").files[0];
  $("file-input").value = "";
  if (!file) return;
  if (file.type.startsWith("audio/") || /\.(ogg|oga|opus|webm|mp3|m4a|mp4|wav|flac)$/i.test(file.name)) {
    transcribeFile(file);
  } else {
    uploadAttachment(file);
  }
});

async function transcribeFile(file) {
  hideEmpty();
  const card = document.createElement("div");
  card.className = "file-card";
  const head = document.createElement("div");
  head.className = "fc-head";
  const spin = document.createElement("span");
  spin.className = "spinner";
  const name = document.createElement("span");
  name.className = "fc-name";
  name.textContent = file.name;
  const status = document.createElement("span");
  status.className = "fc-status";
  status.textContent = "uploading\\u2026";
  head.append(spin, name, status);
  const textEl = document.createElement("div");
  textEl.className = "fc-text";
  card.append(head, textEl);
  conv.appendChild(card);
  maybeScroll(true);

  const fd = new FormData();
  fd.append("file", file);
  let duration = 0, finalText = "";
  try {
    const res = await fetch("/api/transcribe-stream", { method: "POST", body: fd });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || "HTTP " + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\\n\\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\\n")) {
          if (!line.startsWith("data: ")) continue;
          let msg;
          try { msg = JSON.parse(line.slice(6)); } catch { continue; }
          if (msg.type === "info") {
            duration = msg.duration || 0;
            status.textContent = duration ? "0s / " + duration + "s" : "transcribing\\u2026";
          } else if (msg.type === "partial") {
            textEl.textContent = msg.text;
            if (duration && msg.at != null) status.textContent = Math.min(msg.at, duration) + "s / " + duration + "s";
            maybeScroll(false);
          } else if (msg.type === "done") {
            finalText = msg.text;
          } else if (msg.type === "error") {
            throw new Error(msg.error || "transcription failed");
          }
        }
      }
    }
    if (!finalText) throw new Error("transcription came back empty");
    spin.remove();
    card.classList.add("done");
    status.textContent = "transcribed" + (duration ? " (" + duration + "s)" : "");
    textEl.textContent = finalText;
    input.value = finalText;
    input.dispatchEvent(new Event("input"));
    input.focus();
    toast("transcript ready \\u2014 review and press Send");
  } catch (e) {
    spin.remove();
    card.classList.add("err");
    status.textContent = "failed";
    textEl.textContent = e.message;
    toast("transcription failed: " + e.message, true, 8000);
  }
  maybeScroll(true);
}

// ---- send transcript to telegram ----
// Posts the ACTIVE session's transcript to the user's own Telegram chat via
// the app's server-side telegramNotify hook (index.ts wires it to
// bot.api.sendMessage). Never touches the checkpoint — history stays where
// it is; this only mirrors the visible turns onto the phone.
$("tg-btn").onclick = async () => {
  const btn = $("tg-btn");
  if (!sessionActive) { toast("select or start a session first", true); return; }
  if (!confirm("Send this session's transcript to your Telegram chat?")) return;
  btn.disabled = true;
  try {
    const r = await fetch("/api/send-to-telegram", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "send failed", true); return; }
    if (d.followWeb) toast("sent — telegram now follows this session");
    else toast(d.key && d.parts > 1 ? "sent to telegram (" + d.parts + " messages)" : "sent to telegram");
  } catch (e) {
    toast("send failed: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
};

// ---- clear ----
$("clear-btn").onclick = async () => {
  if (!confirm("Clear this conversation? The next message starts a fresh tree.")) return;
  try {
    const r = await fetch("/api/clear", { method: "POST" });
    if (!r.ok) toast("clear failed", true);
  } catch (e) { toast("clear failed: " + e.message, true); }
};

// ---- tree structure side panel ----
const treePanel = $("tree-panel");
const treeBody = $("tree-body");
let treeLoadedFor = null;
const treeVisited = new Set(); // node paths hit during the current turn
let treeActive = null;         // node path of the latest event
// Current memory values, keyed by node path. Seeded/refreshed from
// /api/tree/memory (full values); the per-node DOM buttons are tracked in
// treeMemBtns so live SSE events can update them without re-rendering.
const treeMemory = new Map();
const treeMemBtns = new Map();

function tpEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Open/closed state persists across reloads; the drawer defaults to open.
const TREE_OPEN_KEY = "treePanelOpen";
// Last selected pattern, mirrored client-side so it survives reloads even
// if the server restarts without TREE_PATTERN persisted in .env.
const TREE_PATTERN_KEY = "treePattern";
// Active version ref for NEW sessions (mirrored client-side like the tree).
const TREE_REF_KEY = "treeRef";
function setTreePanelOpen(open) {
  // Non-modal: no backdrop, the chat stays usable while the drawer is open.
  treePanel.classList.toggle("open", open);
  try { localStorage.setItem(TREE_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode */ }
  if (open) loadTreePanel();
}
$("tree-btn").onclick = () => setTreePanelOpen(!treePanel.classList.contains("open"));

// Snapshot / promote from the tree panel. Uses the selector's current tree
// and version; a promote needs a concrete version selected.
async function versionAction(kind) {
  const name = $("pattern-sel").value;
  const ref = $("ref-sel").value;
  if (!name) return;
  const post = (url, body) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }));
  try {
    if (kind === "snapshot") {
      const { ok, d } = await post("/api/tree/versions", { name });
      if (!ok) { toast(d.error || "snapshot failed", true); return; }
      toast(d.created ? "snapshot " + name + "@" + d.version : name + "@" + d.version + " already matches");
      await loadRefSelect(name, d.version);
    } else {
      if (!ref || ref === "prod" || ref === "draft") { toast("select a version to promote", true); return; }
      const { ok, d } = await post("/api/tree/version/promote", { name, version: ref });
      if (!ok) { toast(d.error || "promote failed", true); return; }
      toast("promoted " + name + "@" + d.promoted + (d.demoted ? " (demoted " + d.demoted + ")" : ""));
      await loadRefSelect(name, d.promoted);
    }
    if (treePanel.classList.contains("open")) loadTreePanel(true);
  } catch (e) {
    toast(kind + " failed: " + e.message, true);
  }
}
$("tp-snapshot").onclick = () => versionAction("snapshot");
$("tp-promote").onclick = () => versionAction("promote");

// Show the selected version's paired spec in the tree drawer.
async function showSpec() {
  const name = $("pattern-sel").value;
  const ref = $("ref-sel").value;
  const spec = name && ref && ref !== "prod" ? name + "@" + ref : name;
  if (!spec) return;
  // Open the drawer directly (setTreePanelOpen would immediately load the
  // structure view and race this spec render).
  treePanel.classList.add("open");
  try { localStorage.setItem(TREE_OPEN_KEY, "1"); } catch { /* private mode */ }
  treeBody.innerHTML = "";
  treeBody.appendChild(tpEl("div", "tp-empty", "loading spec\\u2026"));
  try {
    const r = await fetch("/api/tree/spec?pattern=" + encodeURIComponent(spec), { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    treeBody.innerHTML = "";
    if (!r.ok) {
      treeBody.appendChild(tpEl("div", "tp-empty", d.error || "no spec for this version"));
      return;
    }
    treeBody.appendChild(tpEl("div", "tp-info", d.specFile || spec));
    treeBody.appendChild(tpEl("pre", "tp-spec-body", d.spec));
    treeLoadedFor = null; // reopening the tree reloads the structure view
  } catch (e) {
    toast("spec failed: " + e.message, true);
  }
}
$("tp-spec").onclick = () => showSpec();
$("tree-close").onclick = () => setTreePanelOpen(false);

// Runtime bookkeeping rows (record, scope_init) are for debugging the tree,
// not for reading a conversation: hidden by default, revealed on demand.
const INTERNALS_KEY = "gb_show_internals";
function updateCount(block) {
  const show = document.body.classList.contains("show-internals");
  // Only top-level rows count; a collapsed map block is one step, and its
  // item rows belong to it.
  let n = 0;
  for (const li of block.list.children) {
    if (!li.classList.contains("step")) continue;
    if (!show && li.classList.contains("k-internals")) continue;
    n++;
  }
  block.cnt.textContent = n + (n === 1 ? " step" : " steps");
}
function setInternals(on) {
  document.body.classList.toggle("show-internals", on);
  $("internals-btn").classList.toggle("on", on);
  for (const block of blocks.values()) updateCount(block);
  try { localStorage.setItem(INTERNALS_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}
$("internals-btn").onclick = () =>
  setInternals(!document.body.classList.contains("show-internals"));
try {
  setInternals(localStorage.getItem(INTERNALS_KEY) === "1");
} catch { setInternals(false); }

// Machine narration (level "machine") is engine bookkeeping the chat can show
// or hide; visible by default, toggled from the header.
const MACHINE_KEY = "gb_show_machine";
function setMachine(on) {
  document.body.classList.toggle("hide-machine", !on);
  $("machine-btn").classList.toggle("on", on);
  try { localStorage.setItem(MACHINE_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}
$("machine-btn").onclick = () =>
  setMachine(document.body.classList.contains("hide-machine"));
try {
  setMachine(localStorage.getItem(MACHINE_KEY) !== "0");
} catch { setMachine(true); }
try {
  if (localStorage.getItem(TREE_OPEN_KEY) !== "0") setTreePanelOpen(true);
} catch { setTreePanelOpen(true); }

async function loadTreePanel(force) {
  const name = $("pattern-sel").value;
  const ref = $("ref-sel") ? $("ref-sel").value : "";
  const spec = name && ref && ref !== "prod" ? name + "@" + ref : name;
  if (!force && treeLoadedFor && treeLoadedFor === spec) return;
  treeBody.innerHTML = "";
  treeBody.appendChild(tpEl("div", "tp-empty", "loading\\u2026"));
  try {
    const r = await fetch("/api/tree" + (spec ? "?pattern=" + encodeURIComponent(spec) : ""), { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "load failed");
    treeLoadedFor = d.pattern;
    $("tp-pattern").textContent = d.pattern;
    treeBody.innerHTML = "";
    treeMemory.clear();
    treeMemBtns.clear();
    treeBody.appendChild(renderTreeNode(d.tree, true));
    applyTreeMarks();
    refreshTreeMemory();
  } catch (e) {
    treeBody.innerHTML = "";
    treeBody.appendChild(tpEl("div", "tp-empty", "could not load tree: " + e.message));
  }
}

// One info row inside a node's expanded body.
function tpInfo(body, key, value) {
  if (value == null || value === "") return;
  const row = tpEl("div", "tp-info");
  row.append(tpEl("span", "tp-k", key), tpEl("pre", "tp-v", String(value)));
  body.appendChild(row);
}

// Render a serialized tree ({kind:"tree",...}) or a child node. The tree
// header carries model/tools/needs rules; children nest underneath.
function renderTreeNode(n, isRoot) {
  const wrap = tpEl("div", "tp-tree");
  if (isRoot) {
    const head = tpEl("div", "tp-row");
    head.append(tpEl("span", "tp-badge", "tree"), tpEl("span", "tp-name", n.name || "(anon)"));
    head.dataset.path = n.path;
    wrap.appendChild(head);
    const meta = [];
    for (const m of n.models || []) meta.push("model: " + m.value + (m.when ? "   [" + m.when + "]" : ""));
    for (const t of n.tools || []) meta.push("tools: " + t.value.join(", ") + (t.when ? "   [" + t.when + "]" : ""));
    if (n.needs && n.needs.length) {
      const optionalNeeds = new Set(n.optionalNeeds || []);
      meta.push("needs: " + n.needs.map((x) => (optionalNeeds.has(x) ? x + " (optional)" : x)).join(", "));
    }
    if (meta.length) wrap.appendChild(tpEl("pre", "tp-meta", meta.join("\\n")));
  }
  const ul = tpEl("ul", "tp-children");
  for (const c of n.children || []) ul.appendChild(renderTreeChild(c));
  wrap.appendChild(ul);
  return wrap;
}

function renderTreeChild(c) {
  const li = tpEl("li", "tp-node k-" + c.kind);
  li.dataset.path = c.path;

  const body = tpEl("div", "tp-body");
  if (c.text != null) tpInfo(body, "prompt", c.text);
  if (c.messages) tpInfo(body, "messages", c.messages.map((m) => m.role + ": " + m.content).join("\\n\\n"));
  if (c.fn) tpInfo(body, "fn", c.fn);
  if (c.kind === "memory" || c.kind === "memoryUpdate") {
    const row = tpEl("div", "tp-info");
    row.appendChild(tpEl("span", "tp-k", "value"));
    const btn = tpEl("button", "tp-v tp-mem-btn", shortValue(treeMemory.get(c.path)));
    btn.dataset.path = c.path;
    btn.title = "click for full value";
    btn.addEventListener("click", () => openMemoryPopup(c.path, c.name));
    row.appendChild(btn);
    body.appendChild(row);
    treeMemBtns.set(c.path, btn);
  }
  if (c.tool) tpInfo(body, "tool", c.tool);
  if (c.argsFn) tpInfo(body, "args", c.argsFn);
  if (c.tools) tpInfo(body, "tools", c.tools.join(", "));
  if (c.check) tpInfo(body, "check", c.check);
  if (c.flow) tpInfo(body, "on fail", c.flow);
  if (c.loop) tpInfo(body, "loop", c.loop);
  if (c.contextFn) tpInfo(body, "context", c.contextFn);
  if (c.tree) body.appendChild(renderTreeNode(c.tree, true));

  const summary = document.createElement(body.childNodes.length ? "summary" : "div");
  if (!body.childNodes.length) summary.className = "tp-row";
  summary.append(
    tpEl("span", "tp-badge", c.kind),
    tpEl("span", "tp-name", c.name || ""),
  );
  if (c.gate) summary.appendChild(tpEl("span", "tp-gate", c.gate));
  else if (c.kind === "prompt" && c.text != null) summary.appendChild(tpEl("span", "tp-gate", short(c.text, 60)));

  if (body.childNodes.length) {
    const det = document.createElement("details");
    if (c.kind === "branch" || c.kind === "map") det.open = true;
    det.append(summary, body);
    li.appendChild(det);
  } else {
    li.appendChild(summary);
  }
  return li;
}

// ---- memory values ----

// One-line, truncated rendering of a memory value for the inline display.
function shortValue(v) {
  if (v === undefined) return "(no value)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return short(s, 120);
}

// Update the inline (truncated) value shown on a memory node's button.
function updateMemoryNode(path, value) {
  const btn = treeMemBtns.get(path);
  if (btn) btn.textContent = shortValue(value);
}

// Popup showing a memory slot's full value, lazy-loaded from the server so
// nothing large is shipped unless the user asks for it.
function openMemoryPopup(path, label) {
  document.getElementById("mem-popup")?.remove();
  const overlay = tpEl("div", "", null);
  overlay.id = "mem-popup";
  const box = tpEl("div", "mem-box");
  const head = tpEl("div", "mem-head");
  head.appendChild(tpEl("h3", "", label || path));
  const close = tpEl("button", "", "close");
  close.addEventListener("click", () => overlay.remove());
  head.appendChild(close);
  const body = tpEl("div", "mem-body");
  const pre = document.createElement("pre");
  pre.textContent = "loading\u2026";
  body.appendChild(pre);
  box.append(head, body);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  fetch("/api/tree/memory?path=" + encodeURIComponent(path))
    .then((r) => r.json())
    .then((d) => {
      const v = d.value;
      pre.textContent =
        v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v, null, 2);
    })
    .catch((e) => { pre.textContent = "failed to load: " + e.message; });
}

// Refresh the current memory values from the log DB (full values) and update
// every memory node's inline display. Called on panel load and at turn end.
async function refreshTreeMemory() {
  try {
    const r = await fetch("/api/tree/memory");
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.values) return;
    for (const [p, v] of Object.entries(d.values)) {
      treeMemory.set(p, v);
      updateMemoryNode(p, v);
    }
  } catch { /* memory view is best-effort */ }
}

// Debounce live memory refreshes: a turn writes several memory slots in quick
// succession, and each write should update every node bound to that slot (the
// declaring .memory() node included), so we just re-fetch the resolved map.
let memRefreshTimer = null;
function scheduleMemoryRefresh() {
  if (memRefreshTimer) return;
  memRefreshTimer = setTimeout(() => { memRefreshTimer = null; refreshTreeMemory(); }, 150);
}

// ---- live progress marks (driven by the same SSE events as the steps) ----
function applyTreeMarks() {
  let activeEl = null;
  for (const el of treeBody.querySelectorAll("[data-path]")) {
    const p = el.dataset.path;
    const isActive = treeActive != null && p === treeActive;
    el.classList.toggle("tp-active", isActive);
    el.classList.toggle("tp-visited", treeVisited.has(p));
    if (isActive) activeEl = el;
  }
  if (activeEl && treePanel.classList.contains("open")) {
    // Expand ancestors so the active node is actually visible, then scroll to it.
    let p = activeEl.parentElement;
    while (p && p !== treeBody) {
      if (p.tagName === "DETAILS") p.open = true;
      p = p.parentElement;
    }
    activeEl.scrollIntoView({ block: "nearest" });
  }
}

function treeOnEvent(ev) {
  const c = ev.content || {};
  let p = ev.branch_path || "";
  if (c.child) p = p ? p + "/" + c.child : String(c.child);
  if (!p) return;
  treeVisited.add(p);
  treeActive = p;
  const op = ev.content && ev.content.op;
  if (ev.kind === "memory" || (ev.kind === "record" && (op === "memory" || op === "memoryUpdate"))) {
    scheduleMemoryRefresh();
  }
  applyTreeMarks();
}
function treeOnTurnStart() {
  treeVisited.clear();
  treeActive = null;
  applyTreeMarks();
}
function treeOnTurnEnd() {
  treeActive = null;
  applyTreeMarks();
  refreshTreeMemory();
}

// ---- live events over SSE ----
let sseOpened = false;
function connect() {
  const es = new EventSource("/api/events");
  // SSE has no replay: whatever was broadcast while the stream was down is
  // gone, so re-sync the transcript on every open after the first.
  es.onopen = () => {
    if (sseOpened) checkFollow();
    sseOpened = true;
  };
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "turn_start") { startTurn(msg.turnId, msg.input); treeOnTurnStart(); }
    else if (msg.type === "event") { addStep(msg.turnId, msg.event); treeOnEvent(msg.event); }
    else if (msg.type === "emit") { emitToTurn(msg.turnId, msg.text, msg.buttons, msg.level); }
    else if (msg.type === "turn_end") { endTurn(msg.turnId, msg.status, msg.error, msg.output, msg.buttons, msg.emits, msg.levels); treeOnTurnEnd(); }
    else if (msg.type === "cleared") {
      conv.innerHTML = ""; blocks.clear(); rendered.clear(); showEmpty(); treeMemory.clear(); for (const btn of treeMemBtns.values()) btn.textContent = "(no value)";
      // Re-check whether a session is still active (deleting the active
      // one drops us back to the picker).
      refreshSessionOptions().then((d) => setSessionUi(!!d.active, d.active)).catch(() => setSessionUi(false));
    }
    else if (msg.type === "trees") {
      // A version or tree changed in-process: re-sync the selectors now
      // (and the drawer, if it is showing the affected tree).
      treeLoadedFor = null;
      syncTreeSelectors(true).then(() => {
        if (treePanel.classList.contains("open")) loadTreePanel(true);
      }).catch(() => {});
    }
    else if (msg.type === "follow") { checkFollow(); }
    else if (msg.type === "followWeb") { refreshSessionOptions().catch(() => {}); }
  };
}

// ---- history + session selection on load ----
// With auto-follow ON (default) the server keeps the page pinned to the
// live Telegram conversation. Without it, a restart never auto-resumes:
// active=null and the session bar stays up until "resume"/"new chat".
let sessionActive = false;
let trackedActive = null;
// The active session's updatedAt when we last rendered it: lets the poll
// (and the SSE reconnect) notice turns that arrived while the stream was
// down, instead of only reacting to a session switch.
let trackedUpdatedAt = 0;

/** The active session's updatedAt, so new turns can be detected. */
function activeUpdatedAt(d) {
  const key = d.active || null;
  return (d.sessions || []).find((s) => s.key === key)?.updatedAt ?? 0;
}

function renderTurns(list) {
  for (const t of list || []) {
    startTurn(t.turnId, t.input);
    for (const ev of t.events || []) addStep(t.turnId, ev);
    endTurn(t.turnId, t.status, t.error, t.output, t.buttons, t.emits);
  }
}

function setSessionId(key) {
  const wrap = $("session-id-wrap");
  const code = $("session-id");
  if (!key) { wrap.hidden = true; code.textContent = ""; code.removeAttribute("title"); return; }
  code.textContent = key;
  code.title = key;
  wrap.hidden = false;
}

function copySessionId() {
  const text = $("session-id").textContent || "";
  if (!text) return;
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    if (ok) toast("session id copied"); else toast("copy failed", true);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast("session id copied")).catch(fallback);
  } else {
    fallback();
  }
}

function setSessionUi(active, key) {
  sessionActive = active;
  setSessionId(active ? key : null);
  $("session-bar").hidden = active;
  $("input").disabled = !active;
  $("send-btn").disabled = !active;
  $("tg-btn").disabled = !active;
  $("mic-btn").disabled = !active;
  $("file-btn").disabled = !active;
  $("input").placeholder = active ? "type a message\\u2026" : "select or start a session above";
}

async function refreshSessionOptions() {
  const r = await fetch("/api/session");
  const d = await r.json();
  const sel = $("session-sel");
  sel.innerHTML = "";
  for (const s of d.sessions || []) {
    const o = document.createElement("option");
    o.value = s.key;
    if (s.remote) o.dataset.remote = "1";
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
    const parts = [(s.label || "untitled")];
    if (s.pattern) parts.push("[" + s.pattern + "]");
    // Pinned-version badge: the version this session will resume on.
    const refVersion = s.ref && s.ref.includes("@") ? s.ref.split("@")[1] : "";
    if (refVersion) parts.push("@" + refVersion);
    if (when) parts.push(when);
    if (!s.remote) parts.push(s.turns + " turn" + (s.turns === 1 ? "" : "s"));
    o.textContent = (s.remote ? "\\u21c4 " : "") + parts.join(" \\u00b7 ");
    sel.appendChild(o);
  }
  return d;
}

async function loadHistory() {
  try {
    const d = await refreshSessionOptions();
    if (d.active) renderTurns(d.turns);
    trackedActive = d.active || null;
    trackedUpdatedAt = activeUpdatedAt(d);
    setSessionUi(!!d.active, d.active);
  } catch {
    setSessionUi(false); // server unreachable — input stays locked
  }
}

// Re-read the followed session; swap the transcript when the server
// re-targeted it (a newer Telegram conversation became current), and
// append any turns the page never saw (events missed while the SSE stream
// was down — a server restart drops the stream and SSE has no replay).
async function checkFollow() {
  try {
    const d = await refreshSessionOptions();
    const active = d.active || null;
    const updated = activeUpdatedAt(d);
    if (active !== trackedActive) {
      trackedActive = active;
      trackedUpdatedAt = updated;
      conv.innerHTML = "";
      blocks.clear();
      rendered.clear();
      showEmpty();
      if (active) { renderTurns(d.turns); hideEmpty(); }
      setSessionUi(!!active, active);
      if (active) toast("now following: " + (d.label || active));
      return;
    }
    if (updated !== trackedUpdatedAt) {
      trackedUpdatedAt = updated;
      const missing = (d.turns || []).filter((t) => !rendered.has(t.turnId));
      if (missing.length) { renderTurns(missing); hideEmpty(); }
    }
    setSessionUi(!!active, active);
  } catch { /* transient */ }
}
setInterval(() => { if (!document.hidden) checkFollow(); }, 7000);

async function chooseSession(body) {
  try {
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "session failed", true); return; }
    conv.innerHTML = "";
    blocks.clear();
    rendered.clear();
    showEmpty();
    renderTurns(d.turns);
    trackedActive = d.active || null;
    setSessionUi(true, d.active);
    treeLoadedFor = null;
    treeVisited.clear();
    treeActive = null;
    if (treePanel.classList.contains("open")) loadTreePanel(true);
  } catch (e) {
    toast("session failed: " + e.message, true);
  }
}
$("session-resume").onclick = () => {
  const sel = $("session-sel");
  const opt = sel.selectedOptions[0];
  if (!sel.value) return;
  chooseSession({ key: sel.value }).then(() => {
    if (opt && opt.dataset.remote) toast("\\u21c4 following this conversation — it stays live in telegram too");
  });
};
$("session-new").onclick = () => chooseSession({ new: true });
$("session-id-copy").onclick = copySessionId;

showEmpty();
loadHistory();
connect();

// ---- pattern selector -------------------------------------------------
// Populate the version selector for the chosen tree: prod, each snapshot,
// and draft. Choosing one retargets NEW sessions only; live sessions keep
// their pinned version.
async function loadRefSelect(name, activeRef) {
  const sel = document.getElementById("ref-sel");
  if (!sel) return;
  sel.innerHTML = "";
  if (!name) { sel.disabled = true; return; }
  let d = { versions: [], prod: null, draft: false, active: "" };
  try {
    const r = await fetch("/api/tree/versions?name=" + encodeURIComponent(name), { cache: "no-store" });
    if (r.ok) d = await r.json();
  } catch { /* leave defaults */ }
  const active = (activeRef != null && activeRef !== "") ? activeRef : (d.active || "prod");
  const add = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (value === active) o.selected = true;
    sel.appendChild(o);
  };
  add("prod", "prod" + (d.prod ? " (" + d.prod + ")" : ""));
  const byNum = (a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10);
  for (const v of (d.versions || []).slice().sort(byNum)) {
    add(v, v + (d.prod === v ? " \u2713 prod" : ""));
  }
  if (d.draft) add("draft", "draft");
  if (active !== "prod" && active !== "draft" && !(d.versions || []).includes(active)) {
    add(active, active + " (missing)");
  }
  sel.disabled = !d.versions.length && !d.draft;
}
async function setRef(ref) {
  const name = document.getElementById("pattern-sel").value;
  if (!name || !ref) return;
  try {
    const r = await fetch("/api/tree/version/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ref }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "version switch failed", true); return; }
    toast("new sessions use: " + name + (ref && ref !== "prod" ? "@" + ref : " (prod)"));
    try { localStorage.setItem(TREE_REF_KEY, ref); } catch { /* private mode */ }
    // The drawer shows the selected version's structure; reload it.
    treeLoadedFor = null;
    if (treePanel.classList.contains("open")) loadTreePanel(true);
  } catch (e) {
    toast("version switch failed: " + e.message, true);
  }
}

// Patterns and app trees, grouped under optgroup headings.
function buildPatternOptions(sel, patterns, current) {
  sel.innerHTML = "";
  const groups = new Map();
  for (const p of patterns || []) {
    const label = p.group === "app" ? "apps" : "patterns";
    let g = groups.get(label);
    if (!g) {
      g = document.createElement("optgroup");
      g.label = label;
      sel.appendChild(g);
      groups.set(label, g);
    }
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.name;
    if (p.description) o.title = p.description;
    if (p.name === current) o.selected = true;
    g.appendChild(o);
  }
  if (!patterns || !patterns.length) {
    sel.appendChild(new Option("(no patterns)", "", false, false));
  }
}
// A compact fingerprint of every tree's version catalog, so a poll only
// rebuilds the selectors when the directory actually changed.
function treeCatalogSignature(d) {
  // Include the active tree/ref so a switch made in another tab also
  // refocuses the selectors on the next scan.
  return JSON.stringify([
    d.current ?? "",
    d.ref ?? "",
    ...(d.patterns || []).map((p) => [p.name, p.versions, p.specVersions, p.prod, p.draft, p.draftSpec]),
  ]);
}
let treeCatalogSig = "";
// Re-read the directory through the server and refresh the tree/version
// selectors when anything changed — a snapshot, promote, new tree, or a
// manual rename made outside BOB. Runs on an interval and on the "trees"
// SSE event, so the available versions follow the directory automatically.
async function syncTreeSelectors(force) {
  try {
    const r = await fetch("/api/pattern", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    const sig = treeCatalogSignature(d);
    if (!force && sig === treeCatalogSig) return;
    treeCatalogSig = sig;
    const sel = $("pattern-sel");
    const chosen = sel.value || d.current;
    buildPatternOptions(sel, d.patterns, d.current);
    sel.value = (d.patterns || []).some((p) => p.name === chosen) ? chosen : d.current;
    await loadRefSelect(sel.value);
  } catch { /* transient; the next tick retries */ }
}
async function loadPatternSelect() {
  try {
    const r = await fetch("/api/pattern", { cache: "no-store" });
    const d = await r.json();
    const sel = document.getElementById("pattern-sel");
    buildPatternOptions(sel, d.patterns, d.current);
    treeCatalogSig = treeCatalogSignature(d);
    // Restore the last locally-selected pattern if the server no longer
    // has it (e.g. restarted without TREE_PATTERN persisted in .env).
    let saved = null;
    try { saved = localStorage.getItem(TREE_PATTERN_KEY); } catch { /* private mode */ }
    const names = (d.patterns || []).map((p) => p.name);
    if (saved && names.includes(saved) && saved !== d.current) {
      const rr = await fetch("/api/pattern", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: saved }),
      });
      if (rr.ok) sel.value = saved;
    }
    // The drawer may have loaded before the select was populated — resync.
    if (treePanel.classList.contains("open")) loadTreePanel(true);
    await loadRefSelect(sel.value || d.current);
  } catch { /* pattern API unreachable — selector just stays empty */ }
}
async function setPattern(name) {
  if (!name) return;
  try {
    const r = await fetch("/api/pattern", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "pattern switch failed", true); return; }
    toast("pattern: " + d.pattern + " — conversation cleared");
    try { localStorage.setItem(TREE_PATTERN_KEY, name); } catch { /* private mode */ }
    treeLoadedFor = null;
    treeVisited.clear();
    treeActive = null;
    if (treePanel.classList.contains("open")) loadTreePanel(true);
    await loadRefSelect(name);
  } catch (e) {
    toast("pattern switch failed: " + e.message, true);
  }
}
document.getElementById("pattern-sel").addEventListener("change", (e) => setPattern(e.target.value));
document.getElementById("ref-sel").addEventListener("change", (e) => setRef(e.target.value));
loadPatternSelect();
// Keep the available versions in step with the directory: catches snapshots
// made from Telegram, other tabs, or a manual rename, none of which can push.
setInterval(() => { if (!document.hidden) syncTreeSelectors(); }, 8000);

// ---- service health dots (telegram / voice / llm) ----
const HEALTH_LABEL = { telegram: "telegram", voice: "voice", llm: "models" };
async function loadHealth() {
  try {
    const r = await fetch("/api/status");
    const d = await r.json();
    const host = $("health-dots");
    if (!host) return;
    host.innerHTML = "";
    for (const svc of d.services || []) {
      const el = document.createElement("span");
      el.className = "hdot " + (svc.up === true ? "up" : svc.up === false ? "down" : "na");
      el.title = svc.name + ": " + svc.detail;
      const dot = document.createElement("i");
      el.append(dot, " " + (HEALTH_LABEL[svc.name] || svc.name));
      host.appendChild(el);
    }
  } catch { /* status unreachable — leave dots as-is */ }
}
loadHealth();
setInterval(() => { if (!document.hidden) loadHealth(); }, 10000);
</script>
</body>
</html>
`;
}
