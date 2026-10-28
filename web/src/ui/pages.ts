// The settings page — the exact Node admin HTML, rendered verbatim by both the
// Node server and the browser target, so they share one UI. The chat surface is
// the tiled SolidJS app in `ui/` (served at `/`), not a server-rendered page.

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
  /* Marks a control that needs the admin server (BOB_WEB=1). */
  .srv { display: inline-flex; align-items: center; margin-left: 5px; color: var(--muted); vertical-align: middle; }
  .srv svg { display: block; }
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
    <span id="service-dots" class="row" style="gap:14px" data-srv></span>
    <span class="status" id="server-mode"><span class="dot on"></span> admin (this)</span>
    <span style="margin-left:auto"><small id="uptime"></small></span>
  </div>
  <div class="row" style="margin-top:8px">
    <label class="status" data-srv title="The webui automatically continues whichever conversation is live on Telegram. Telegram never picks up web chats.">
      <input type="checkbox" id="follow-chk" style="margin:0 6px 0 0"> webui follows telegram
    </label>
    <small style="color:var(--muted)">one-way: telegram never follows the webui</small>
  </div>
  <div id="server-note" style="display:none; margin-top:8px; color:#f59e0b; font-size:12px"></div>
  <div class="actions">
    <button id="restart-btn" data-srv onclick="restartBot()">Restart bot</button>
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
    <input id="sync-local" type="text" value="main" placeholder="main" style="width:120px">
    <span style="color:var(--muted)">→</span>
    <input id="sync-remote" type="text" value="main" placeholder="main" style="width:120px">
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
    <label>Neuralwatt API key <span id="cur-neuralwatt" style="float:right"></span></label>
    <input id="f-neuralwatt" type="password" placeholder="sk-...">
    <label>Exa search API key <span id="cur-exo" style="float:right"></span></label>
    <input id="f-exo" type="password" placeholder="exa-... (used by exa_search)">
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
  <p style="margin:4px 0"><small>Named model slots the trees reference (<code>Model("strong")</code>, <code>Model("cheap")</code>). Each slot points at any OpenAI-compatible endpoint (Ollama local/cloud, OpenAI, Neuralwatt, OpenRouter, llama.cpp&hellip;) or native Ollama. Pick a provider preset, choose a model, then <b>Test</b>. Saving applies immediately &mdash; no restart. Keys may use <code>\${ENV}</code> to reference the credentials above, or be pasted literally.</small></p>
  <div id="model-slots">(loading...)</div>
  <datalist id="models-datalist"></datalist>
  <div class="actions">
    <button class="secondary" onclick="addModelSlot()">+ Add model</button>
    <button onclick="saveModels()">Save models</button>
    <button class="secondary" onclick="toggleRawModels()">Raw JSON</button>
    <span id="models-status"></span>
  </div>
  <div id="models-raw-wrap" style="display:none; margin-top:10px">
    <textarea id="models-json" rows="9" style="width:100%;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace" placeholder='{"strong":{"baseURL":"https://api.neuralwatt.com/v1","apiKey":"\${NEURALWATT_API_KEY}","model":"glm-5.3"}}'></textarea>
    <p style="margin:4px 0"><small>Raw registry JSON &mdash; the exact file that is saved. Edits here are honored on save; otherwise the form above builds it.</small></p>
  </div>
</div>

<div class="card">
  <h2 style="margin-top:0">Logs</h2>
  <div class="row" style="margin-bottom:8px">
    <button class="secondary log-btn" data-srv onclick="loadLog('bot')">bot.log</button>
    <button class="secondary log-btn" data-srv onclick="loadLog('sherpa')">sherpa.log</button>
    <span style="margin-left:auto"><small>last 60 lines</small></span>
  </div>
  <pre id="log">(click a log button)</pre>
</div>

<div class="card">
  <h2 style="margin-top:0">Tree patterns</h2>
  <p style="margin:4px 0"><small>grandma-kat trees (<code>patterns/&lt;name&gt;.prod.mjs</code>) in <code>workspace/patterns/</code>. The agent re-reads the active tree each turn — edit it to change behavior without restarting. The agent can also modify its own patterns using file tools. <b>Which one runs</b> is selected from the dropdown on the <a href="/" style="color:var(--accent)">chat page</a> (persisted as <code>TREE_PATTERN</code> in <code>.env</code>).</small></p>
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

// After a server restart with changed page code, a tab keeps running the JS it
// loaded (and would miss fixes) until a manual reload. The server fingerprints
// its pages; reload when ours no longer matches.
function checkUiVersion(v) {
  if (v && window.__UI_VERSION__ && v !== window.__UI_VERSION__) location.reload();
}

// A little server glyph on every control that only works when this page is
// talking to the admin (BOB_WEB=1): service health, Telegram follow, restart,
// bot logs. Disabled controls keep the glyph — it is the reason they are off.
var SERVER_SVG =
  '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">' +
  '<rect x="1.5" y="1.2" width="9" height="3.7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<rect x="1.5" y="7.1" width="9" height="3.7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<circle cx="3.6" cy="3.05" r=".8" fill="currentColor"/>' +
  '<circle cx="3.6" cy="8.95" r=".8" fill="currentColor"/></svg>';

function markServerFeatures() {
  document.querySelectorAll("[data-srv]").forEach(function (el) {
    var icon = document.createElement("span");
    icon.className = "srv";
    icon.title = "Needs the admin server (BOB_WEB=1)";
    icon.innerHTML = SERVER_SVG;
    el.appendChild(icon);
  });
}

// The settings page runs in two hosts: the admin server (real .env, secrets,
// logs, restart) and the browser target, where the page is shimmed onto the
// in-browser backend. Ask which host this is, once, and keep server-only
// controls visible but disabled when no admin is behind the page.
let serverAdmin = true;
async function loadCapabilities() {
  try {
    const r = await fetch("/api/capabilities");
    const d = r.ok ? await r.json() : null;
    serverAdmin = d ? d.admin === true : false;
  } catch { serverAdmin = false; }
  if (serverAdmin) return;
  const mode = $("server-mode");
  if (mode) {
    mode.innerHTML = '<span class="dot" style="background:#f59e0b"></span> browser only';
    mode.title = "No admin server behind this page — settings run in this tab.";
  }
  const note = $("server-note");
  if (note) {
    note.style.display = "";
    note.textContent = "No admin server (BOB_WEB=1) — the Telegram bridge, service health, bot logs and restart are unavailable. Everything below applies to this browser workspace.";
  }
  const why = "Needs the admin server — run the bot with BOB_WEB=1";
  const off = (el) => { el.disabled = true; el.title = why; };
  const restart = $("restart-btn");
  if (restart) off(restart);
  const follow = $("follow-chk");
  if (follow) off(follow);
  document.querySelectorAll(".log-btn").forEach(off);
}

async function refreshStatus() {
  const s = await api("/api/status");
  checkUiVersion(s.uiVersion);
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
  $("cur-neuralwatt").textContent = env.NEURALWATT_API_KEY ? "current: " + env.NEURALWATT_API_KEY.slice(0,6) + "..." : "(unset)";
  $("cur-exo").textContent = env.EXO_API_KEY ? "current: " + env.EXO_API_KEY.slice(0,6) + "..." : "(unset)";
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
    // Pasting a whole KEY=value line into the name box is the common slip —
    // split it across both boxes instead of saving a key literally named that.
    k.oninput = () => {
      const eq = k.value.indexOf("=");
      if (eq > 0) {
        const name = k.value.slice(0, eq).trim().replace(/^export\\s+/i, "");
        if (name) {
          r.key = name;
          r.value = k.value.slice(eq + 1).trim();
          k.value = name;
          v.value = r.value;
        }
        return;
      }
      r.key = k.value;
    };
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

// A key name the .env editor and dotenv both understand.
function validEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key);
}

async function saveAllEnv() {
  const updates = collectEnvUpdates();
  if (!Object.keys(updates).length) {
    // Say *why* there is nothing to save: an empty editor and a blank KEY NAME
    // box are different mistakes, and the old catch-all sent people in circles.
    const rows = envRows.filter((r) => !r.removed);
    if (!rows.length) { toast("no keys loaded — press + Add key first", true); return; }
    if (rows.some((r) => !r.key.trim() && r.value.trim())) {
      toast("put the key name in the left box — rows with a value but no name are skipped", true);
      return;
    }
    if (rows.every((r) => !r.key.trim() && !r.value.trim())) {
      toast("type the key name in the left box and its value on the right", true);
      return;
    }
    toast("nothing to change — edit a value, add a key, or remove one", true);
    return;
  }
  const bad = Object.keys(updates).filter((k) => k && !validEnvKey(k));
  if (bad.length) { toast("invalid key name: " + bad[0] + " — use letters, digits, _ . -", true); return; }
  try {
    await api("/api/env", { method: "POST", body: JSON.stringify(updates) });
    // With the admin behind the page this edits .env (bot restart to apply);
    // hosted by the in-browser backend it writes the browser profile instead.
    toast(serverAdmin ? "saved — restart the bot to apply" : "saved to this browser profile — applies immediately");
    envRows = [];
    renderEnvKeys();
    await refreshStatus();
  } catch {}
}

// ---- app secrets -----------------------------------------------------
// A dotted field key, the shape the vars endpoint accepts ("auth.token").
function validFieldKey(key) {
  return /^[A-Za-z0-9_.-]+$/.test(key) && !key.startsWith(".") && !key.endsWith(".") && !key.includes("..");
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
        // Key/value editor for JSON secrets. Each row saves just its own field
        // (dotted keys expand to nested: auth.token -> { auth: { token } });
        // the endpoint merges, so the fields you did not touch stay put.
        const editor = document.createElement("div");
        editor.style.cssText = "flex:1 1 100%;display:flex;flex-direction:column;gap:6px";
        const rowsBox = document.createElement("div");
        rowsBox.style.cssText = "display:flex;flex-direction:column;gap:4px";
        const saveField = async (key, value) => {
          if (!key) { toast("enter a key first", true); return; }
          if (!validFieldKey(key)) { toast("invalid key: " + key, true); return; }
          if (value === "") { toast("enter a value (delete the secret to remove it)", true); return; }
          try {
            const r = await fetch("/api/secrets/vars?app=" + encodeURIComponent(s.app) + "&name=" + encodeURIComponent(s.name), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key, value }),
            });
            const d2 = await r.json().catch(() => ({}));
            if (!r.ok) { toast(d2.error || "save failed", true); return; }
            toast("saved " + key + " for " + s.name);
            status.textContent = "\u2713 saved";
            status.style.color = "var(--green,#10b981)";
          } catch (e) { toast("save failed: " + e.message, true); }
        };
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
          const sv = document.createElement("button");
          sv.className = "secondary";
          sv.textContent = "save";
          sv.title = "save just this field; the others are left alone";
          sv.onclick = () => saveField(k.value.trim(), v.value);
          v.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveField(k.value.trim(), v.value); } });
          const rm = document.createElement("button");
          rm.className = "secondary";
          rm.textContent = "\u00d7";
          rm.onclick = () => r.remove();
          r.append(k, v, sv, rm);
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
        save.textContent = "Save all";
        save.title = "save every filled field; the fields you leave blank are not touched";
        save.onclick = async () => {
          const set = {};
          let bad = "";
          rowsBox.querySelectorAll("div").forEach((r) => {
            const inputs = r.querySelectorAll("input");
            const key = inputs[0].value.trim();
            const val = inputs[1].value;
            if (!key) return;
            if (!validFieldKey(key)) { bad = key; return; }
            if (val === "") return;
            set[key] = val;
          });
          if (bad) { toast("invalid key: " + bad, true); return; }
          if (!Object.keys(set).length) { toast("enter at least one value", true); return; }
          try {
            const r = await fetch("/api/secrets/vars?app=" + encodeURIComponent(s.app) + "&name=" + encodeURIComponent(s.name), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ set }),
            });
            const d2 = await r.json().catch(() => ({}));
            if (!r.ok) { toast(d2.error || "save failed", true); return; }
            toast("saved vars for " + s.app + "/" + s.name);
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

// ---- structured model registry editor --------------------------------
// The form is the primary editor; it builds the exact JSON that gets saved,
// and the Raw JSON toggle reveals the same text for hand-editing. Provider
// presets only autofill base URL + protocol — every field stays editable.
const MODEL_PRESETS = {
  "ollama-local":  { label: "Ollama (local)",        baseURL: "http://127.0.0.1:11434", protocol: "ollama" },
  "ollama-cloud":  { label: "Ollama cloud",          baseURL: "https://ollama.com",     protocol: "ollama" },
  "neuralwatt":    { label: "Neuralwatt",            baseURL: "https://api.neuralwatt.com/v1" },
  "openai":        { label: "OpenAI",                baseURL: "https://api.openai.com/v1" },
  "openrouter":    { label: "OpenRouter",            baseURL: "https://openrouter.ai/api/v1" },
  "llamacpp":      { label: "llama.cpp / LM Studio", baseURL: "http://127.0.0.1:1234/v1" },
  "custom":        { label: "Custom",                baseURL: "" },
};
let modelRegistry = {};

function escAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function presetId(baseURL, protocol) {
  const b = baseURL || "", p = protocol || "";
  for (const id in MODEL_PRESETS) {
    const pr = MODEL_PRESETS[id];
    if ((pr.baseURL || "") === b && (pr.protocol || "") === p) return id;
  }
  return "custom";
}
function rawModelsOpen() {
  const w = $("models-raw-wrap");
  return !!w && w.style.display !== "none";
}
function slotCard(name, entry) {
  const alias = typeof entry === "string" ? entry : "";
  entry = entry && typeof entry === "object" ? entry : {};
  const preset = presetId(entry.baseURL, entry.protocol);
  let opts = "";
  for (const id in MODEL_PRESETS) {
    opts += '<option value="' + id + '"' + (id === preset ? " selected" : "") + ">" + escAttr(MODEL_PRESETS[id].label) + "</option>";
  }
  const card = document.createElement("div");
  card.dataset.slot = name;
  card.style.cssText = "border:1px solid var(--border,#334155);border-radius:8px;padding:10px 12px;margin-bottom:10px";
  card.innerHTML =
    '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">' +
      '<label style="flex:1;min-width:110px">slot<input class="ms-name" type="text" value="' + escAttr(name) + '"></label>' +
      '<label style="flex:2;min-width:150px">provider<select class="ms-preset">' + opts + "</select></label>" +
      '<button class="secondary ms-del" type="button">remove</button>' +
    "</div>" +
    '<label>alias of<input class="ms-alias" type="text" value="' + escAttr(alias) + '" placeholder="another slot name (optional - this slot becomes a pointer)"></label>' +
    '<label>base URL<input class="ms-base" type="text" value="' + escAttr(entry.baseURL || "") + '" placeholder="https://api.neuralwatt.com/v1"></label>' +
    '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<label style="flex:2;min-width:160px">model<input class="ms-model" type="text" list="models-datalist" value="' + escAttr(entry.model || "") + '" placeholder="model id"></label>' +
      '<label style="flex:1;min-width:130px">protocol<select class="ms-protocol"><option value=""' + (!entry.protocol ? " selected" : "") + '>OpenAI-compatible</option><option value="ollama"' + (entry.protocol === "ollama" ? " selected" : "") + '>Ollama native</option></select></label>' +
    "</div>" +
    '<label>API key<input class="ms-key" type="text" value="' + escAttr(entry.apiKey || "") + '" placeholder="\${ENV_VAR} or literal key"></label>' +
    '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">' +
      '<label style="flex:1;min-width:130px">transform<select class="ms-transform"><option value=""' + (!entry.transform ? " selected" : "") + '>none</option><option value="gemma4Thinking"' + (entry.transform === "gemma4Thinking" ? " selected" : "") + '>gemma4Thinking</option></select></label>' +
      '<button class="secondary ms-test" type="button">Test</button>' +
      '<span class="ms-test-status" style="font-size:12px;color:var(--muted,#94a3b8)"></span>' +
    "</div>" +
    '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">' +
      '<label style="flex:1;min-width:140px">thinking: reasoning_effort<input class="ms-reasoning" type="text" value="' + escAttr(entry.thinking && entry.thinking.reasoning_effort != null ? entry.thinking.reasoning_effort : "") + '" placeholder="low / medium / high"></label>' +
      '<label style="flex:1;min-width:120px">Ollama think<select class="ms-think"><option value=""' + (!entry.thinking || entry.thinking.think === undefined ? " selected" : "") + '>default</option><option value="true"' + (entry.thinking && entry.thinking.think === true ? " selected" : "") + '>true</option><option value="false"' + (entry.thinking && entry.thinking.think === false ? " selected" : "") + '>false</option></select></label>' +
      '<label style="flex:2;min-width:160px">thinking: options JSON<input class="ms-think-options" type="text" value="' + escAttr(entry.thinking && entry.thinking.options ? JSON.stringify(entry.thinking.options) : "") + '" placeholder="optional JSON, e.g. num_ctx"></label>' +
    "</div>";
  card.querySelector(".ms-preset").addEventListener("change", (e) => {
    const pr = MODEL_PRESETS[e.target.value];
    if (!pr || e.target.value === "custom") { syncModelsJson(); return; }
    card.querySelector(".ms-base").value = pr.baseURL || "";
    card.querySelector(".ms-protocol").value = pr.protocol || "";
    syncModelsJson();
  });
  card.querySelector(".ms-del").addEventListener("click", () => { card.remove(); syncModelsJson(); });
  card.querySelector(".ms-test").addEventListener("click", () => testModelSlot(card));
  // An alias pointer leaves the endpoint fields unused; dim them so it is
  // obvious which fields matter (readSlot returns the alias string).
  const aliasInput = card.querySelector(".ms-alias");
  const aliasFields = card.querySelectorAll(
    ".ms-preset,.ms-base,.ms-model,.ms-protocol,.ms-key,.ms-transform,.ms-reasoning,.ms-think,.ms-think-options",
  );
  const syncAliasMode = () => {
    const on = !!aliasInput.value.trim();
    aliasFields.forEach((el) => { el.disabled = on; });
  };
  aliasInput.addEventListener("input", syncAliasMode);
  syncAliasMode();
  card.querySelectorAll("input,select").forEach((el) => {
    el.addEventListener("input", syncModelsJson);
    el.addEventListener("change", syncModelsJson);
  });
  return card;
}
function renderModelSlots() {
  const host = $("model-slots");
  if (!host) return;
  host.innerHTML = "";
  const names = Object.keys(modelRegistry);
  if (!names.length) { host.innerHTML = '<p><small>(no model slots yet - add one)</small></p>'; return; }
  for (const name of names) host.appendChild(slotCard(name, modelRegistry[name]));
}
function readSlot(card) {
  const alias = (card.querySelector(".ms-alias").value || "").trim();
  if (alias) return alias;
  const entry = {};
  const v = (sel) => { const el = card.querySelector(sel); return el ? el.value.trim() : ""; };
  entry.baseURL = v(".ms-base");
  entry.model = v(".ms-model");
  const key = v(".ms-key"); if (key) entry.apiKey = key;
  const proto = v(".ms-protocol"); if (proto) entry.protocol = proto;
  const tf = v(".ms-transform"); if (tf) entry.transform = tf;
  const thinking = {};
  const thReasoning = v(".ms-reasoning");
  if (thReasoning) thinking.reasoning_effort = thReasoning;
  const thThink = v(".ms-think");
  if (thThink === "true") thinking.think = true;
  else if (thThink === "false") thinking.think = false;
  const thOptions = v(".ms-think-options");
  if (thOptions) {
    try {
      const parsed = JSON.parse(thOptions);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) thinking.options = parsed;
    } catch (e) { /* ignore invalid JSON while typing */ }
  }
  if (Object.keys(thinking).length) entry.thinking = thinking;
  return entry;
}
function readModelForm() {
  const out = {};
  const host = $("model-slots");
  if (!host) return out;
  host.querySelectorAll("[data-slot]").forEach((card) => {
    const name = card.querySelector(".ms-name").value.trim();
    if (name) out[name] = readSlot(card);
  });
  return out;
}
function syncModelsJson() {
  if (rawModelsOpen()) return;
  modelRegistry = readModelForm();
  const t = $("models-json");
  if (t) t.value = JSON.stringify(modelRegistry, null, 2);
}
function addModelSlot() {
  if (rawModelsOpen()) { $("models-raw-wrap").style.display = "none"; }
  modelRegistry = readModelForm();
  let n = 1;
  while (modelRegistry["model" + n]) n++;
  modelRegistry["model" + n] = {};
  renderModelSlots();
  syncModelsJson();
  const host = $("model-slots");
  const last = host && host.lastElementChild;
  const nameInput = last && last.querySelector(".ms-name");
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}
function toggleRawModels() {
  const wrap = $("models-raw-wrap");
  if (!wrap) return;
  if (rawModelsOpen()) {
    wrap.style.display = "none";
    try {
      modelRegistry = JSON.parse($("models-json").value || "{}");
      renderModelSlots();
    } catch (e) { toast("invalid JSON: " + e.message, true); }
  } else {
    syncModelsJson();
    wrap.style.display = "block";
  }
}
async function testModelSlot(card) {
  const status = card.querySelector(".ms-test-status");
  const slot = readSlot(card);
  const target = typeof slot === "string" ? modelRegistry[slot] : slot;
  if (!target || typeof target !== "object") {
    status.textContent = typeof slot === "string" ? 'alias "' + slot + '" has no slot' : "no model fields";
    status.style.color = "var(--red,#ef4444)";
    return;
  }
  status.textContent = "testing...";
  status.style.color = "var(--muted,#94a3b8)";
  try {
    const d = await api("/api/models/test", { method: "POST", body: JSON.stringify(target) });
    const dl = $("models-datalist");
    if (dl && Array.isArray(d.models)) {
      dl.innerHTML = "";
      for (const m of d.models) dl.appendChild(new Option(m, m));
    }
    const n = Array.isArray(d.models) ? d.models.length : 0;
    status.textContent = (d.ok ? "reachable" : "unreachable") + (n ? " - " + n + " model(s)" : "");
    status.style.color = d.ok ? "var(--green,#10b981)" : "var(--red,#ef4444)";
  } catch (e) {
    status.textContent = e.message || "test failed";
    status.style.color = "var(--red,#ef4444)";
  }
}
async function loadModels() {
  try {
    const d = await api("/api/models");
    const t = $("models-json");
    if (t) t.value = d.json || "";
    try {
      modelRegistry = d.json ? JSON.parse(d.json) : {};
    } catch {
      modelRegistry = {};
      if (d.json) {
        if ($("models-raw-wrap")) $("models-raw-wrap").style.display = "block";
        toast("models.json is not valid JSON - fix it in Raw JSON", true);
      }
    }
    renderModelSlots();
  } catch { /* optional */ }
}
async function saveModels() {
  const t = $("models-json");
  if (!t) return;
  try {
    if (!rawModelsOpen()) syncModelsJson();
    const d = await api("/api/models", { method: "POST", body: JSON.stringify({ json: t.value }) });
    modelRegistry = JSON.parse(t.value || "{}");
    renderModelSlots();
    const reach = d.reachable || {};
    const names = Object.keys(reach);
    const bad = names.filter((n) => !reach[n]);
    toast(
      bad.length ? "saved - unreachable: " + bad.join(", ") : "models saved and applied" + (names.length ? " (" + names.length + " slot(s))" : ""),
      bad.length > 0,
    );
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
  if ($("f-neuralwatt").value) body.NEURALWATT_API_KEY = $("f-neuralwatt").value;
  if ($("f-exo").value)    body.EXO_API_KEY         = $("f-exo").value;
  if (Object.keys(body).length === 0) { toast("nothing to save", true); return; }
  try {
    await api("/api/env", { method: "POST", body: JSON.stringify(body) });
    toast("saved");
    $("f-token").value = $("f-uid").value = $("f-hf").value = $("f-ollama").value = $("f-neuralwatt").value = $("f-exo").value = "";
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
  const local = $("sync-local").value.trim() || "main";
  const remote = $("sync-remote").value.trim() || local;
  $("sync-status").textContent = "pulling " + remote + "...";
  $("sync-status").style.color = "var(--muted)";
  try {
    const r = await api("/api/sync/pull", { method: "POST", body: JSON.stringify({ local, remote }) });
    syncResult(r, "pulled " + remote, "pull failed: " + remote);
  } catch (e) { $("sync-status").textContent = "✗ " + e.message; $("sync-status").style.color = "var(--red)"; toast("pull failed", true, 8000); }
}

async function gitPush() {
  const local = $("sync-local").value.trim() || "main";
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

markServerFeatures();
loadCapabilities();
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
