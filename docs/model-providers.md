# Model providers (`models.json`)

BOB talks to language models through named slots in a `models.json` registry.
A slot is a plain OpenAI-compatible chat endpoint, or native Ollama. The
browser app loads the registry from the active profile's workspace, from
**Settings → Models** (which overrides the workspace file), or from the admin
server when the page is served by one. A desktop profile mirrors the same
workspace file.

Per-conversation roles (`cheap`, `strong`) point at slots. A role can be
overridden in the session panel; aliases let one slot serve several names.

## Slot fields

```json
{
  "commandcode": {
    "baseURL": "https://api.commandcode.ai/provider/v1",
    "model": "deepseek/deepseek-v4.1-flash",
    "apiKey": "${COMMAND_CODE_API_KEY}",
    "thinking": { "reasoning_effort": "high" },
    "timeout": 180000,
    "idleTimeout": 60000,
    "retries": 2
  }
}
```

| Field | Meaning |
|---|---|
| `baseURL` | API root. BOB appends `/chat/completions` (or `/api/chat` for Ollama), so do **not** include the operation path here. |
| `model` | Provider's model id, sent verbatim. |
| `apiKey` | Bearer token. `${ENV_VAR}` is interpolated from browser settings (standalone) or `.env` (admin-served page); a missing variable becomes an empty string. |
| `protocol` | Omit for OpenAI-compatible APIs. Set `"ollama"` only for Ollama's native `/api/chat`. |
| `transform` | Optional response transform. `gemma4Thinking` strips Gemma channel tags. |
| `thinking.reasoning_effort` | Sent as `reasoning_effort` on OpenAI-compatible calls. |
| `timeout` | Whole-call deadline in ms. Defaults: 2 min OpenAI-compatible, 10 min Ollama. |
| `idleTimeout` | Max gap between body bytes before the call is treated as stalled. |
| `retries` | Attempts for transient failures (429/5xx/transport). |

An entry may also be a string naming another slot:

```json
{
  "v4.1": { "baseURL": "…", "model": "…", "apiKey": "…" },
  "strong": "v4.1"
}
```

Alias chains are followed; cycles and unknown targets are rejected when the
registry loads.

## Presets

**Settings → Models → provider** offers these roots:

| Preset | Base URL | Protocol |
|---|---|---|
| Ollama (local) | `http://127.0.0.1:11434` | native |
| Ollama cloud | `https://ollama.com` | native |
| Neuralwatt | `https://api.neuralwatt.com/v1` | OpenAI-compatible |
| CommandCode | `https://api.commandcode.ai/provider/v1` | OpenAI-compatible |
| OpenAI | `https://api.openai.com/v1` | OpenAI-compatible |
| OpenRouter | `https://openrouter.ai/api/v1` | OpenAI-compatible |
| llama.cpp / LM Studio | `http://127.0.0.1:1234/v1` | OpenAI-compatible |
| Custom | any | editable |

Presets only fill the root and protocol; model id, key and call bounds stay
editable.

## CommandCode

CommandCode's **Provider API** is OpenAI-compatible and uses the same API key
as the CommandCode CLI. It is CORS-enabled, so the standalone browser app can
call it directly.

1. Create or copy a key:
   - Command Code Studio → API keys: <https://commandcode.ai/studio/>
   - or the key already used by the CLI: `~/.commandcode/auth.json` (`apiKey`)
2. In BOB: **Settings → Credentials & .env → CommandCode API key**, paste the
   key, and save. It is stored in this browser profile, not in the workspace.
3. In **Settings → Models**, add or edit a slot:
   - provider: **CommandCode**
   - model: `deepseek/deepseek-v4.1-flash` (or another id below)
   - API key: `${COMMAND_CODE_API_KEY}`
   - **Test**, then **Save**.
4. Select the slot for `cheap`/`strong` in the session panel, or alias it in
   the registry.

Seeded registries (fresh profiles and `web/public/models.standalone.json`)
include:

```json
{
  "commandcode": {
    "baseURL": "https://api.commandcode.ai/provider/v1",
    "model": "deepseek/deepseek-v4.1-flash",
    "apiKey": "${COMMAND_CODE_API_KEY}"
  },
  "commandcode-cheap": {
    "baseURL": "https://api.commandcode.ai/provider/v1",
    "model": "deepseek/deepseek-v4-flash",
    "apiKey": "${COMMAND_CODE_API_KEY}"
  }
}
```

The live model list is
`GET https://api.commandcode.ai/provider/v1/models`. Use a model whose
`supported_endpoints` includes `/chat/completions`. CommandCode's Claude
models only answer on Anthropic's `/v1/messages` endpoint, which this client
does not speak.

### CommandCode troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401 Your API key has expired` | The key in the shell or settings is stale. Create a new key in Studio, or use the current `apiKey` in `~/.commandcode/auth.json`; run `cmd login` to refresh the CLI. |
| `404 … is not a registered API route` | `baseURL` is missing `/provider/v1` or includes `/chat/completions`. Use the exact root from the table. |
| `400 unsupported_model` / `invalid_request_error` | The model id is wrong for this endpoint, or the model is Claude-only (`/messages`). Pick a `/chat/completions` model. |
| `403 upgrade_required` | The CommandCode plan has no API access. Upgrade in Studio, or use a different provider. |
| Browser says CORS/network error | CommandCode allows browser calls; check a proxy or extension is not stripping CORS headers. The Settings **Test** button probes `/models` from the tab. |

## Secrets

- Standalone browser: keys live in `localStorage` (`bob:env`) via
  **Settings → Credentials & .env**, and reach the provider directly.
- Admin-served page: keys live in the admin's `.env`; the page uses the admin's
  `models.json` and `/api/llm` proxy.
- Seed publication never includes `.env` or literal keys; registry entries
  should reference `${ENV_VAR}` instead.
- `models.json` itself is gitignored because a hand-edited registry can carry
  a literal key. Commit `models.example.json` and the standalone template, not
  the live file.

## Verifying

```sh
npm run test:models      # parser + provider preset/template agreement
npm run test:standalone  # browser target imports nothing outside web/ + ui/
npm --prefix web run typecheck
```

A real endpoint check from the tab is **Settings → Models → Test**; it calls
`<baseURL>/models` with the slot's key and lists the advertised ids.
