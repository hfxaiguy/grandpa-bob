#!/bin/sh
# bob-browser — open BOB in an automation-ready Chrome (Linux / macOS).
#
# Usage:
#   curl -fsSL https://bobkat.hfxaiguy.com/scripts/bob-browser.sh | sh -s -- [app-url]
#
# The script launches a *separate* Chrome profile (your normal browser is
# untouched) with the DevTools port and Origin allowlist BOB's browser tools
# need, reads the browser-level debugger socket, and opens the app with
# `?cdp=<socket>` so BOB connects without any further setup.
#
# The printed URL carries this machine's automation socket: treat it as a
# local secret and do not share it.
#
# Environment:
#   BOB_CDP_PORT=9222            debug port
#   BOB_CHROME=/path/to/chrome   explicit Chrome/Chromium binary
#   BOB_PROFILE_DIR=~/.bobkat/chrome-profile
#   BOB_BROWSER_HEADLESS=1       no window (prints the URL only)
#   BOB_NO_OPEN=1                print the URL instead of opening it
set -eu

APP="${1:-https://bobkat.hfxaiguy.com}"
PORT="${BOB_CDP_PORT:-9222}"
PROFILE_DIR="${BOB_PROFILE_DIR:-$HOME/.bobkat/chrome-profile}"
HOST="127.0.0.1"
BASE="http://$HOST:$PORT"

# --remote-allow-origins needs scheme://host[:port] — no path, no query.
case "$APP" in
  http://?*|https://?*) : ;;
  *)
    echo "bob-browser: the app URL must start with http(s):// (got: $APP)" >&2
    exit 1
    ;;
esac
ORIGIN=$(printf '%s' "$APP" | sed -E 's#^(https?://[^/]+).*#\1#')

find_chrome() {
  if [ -n "${BOB_CHROME:-}" ]; then
    [ -x "$BOB_CHROME" ] && printf '%s\n' "$BOB_CHROME"
    return 0
  fi
  for candidate in \
    google-chrome \
    google-chrome-stable \
    chromium \
    chromium-browser \
    /usr/bin/google-chrome \
    /usr/bin/google-chrome-stable \
    /usr/bin/chromium \
    /usr/bin/chromium-browser \
    /snap/bin/chromium \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 0
}

CHROME=$(find_chrome)
if [ -z "$CHROME" ]; then
  echo "bob-browser: Chrome or Chromium was not found — install one, or set BOB_CHROME." >&2
  exit 1
fi

# Reuse an instance already listening on the debug port (a previous run).
if ! curl -fsS "$BASE/json/version" >/dev/null 2>&1; then
  mkdir -p "$PROFILE_DIR"
  EXTRA=""
  if [ "${BOB_BROWSER_HEADLESS:-0}" = "1" ]; then
    EXTRA="--headless=new --disable-gpu"
  fi
  # shellcheck disable=SC2086
  "$CHROME" \
    --remote-debugging-port="$PORT" \
    --remote-allow-origins="$ORIGIN" \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    $EXTRA \
    about:blank >/dev/null 2>&1 &
  i=0
  while [ "$i" -lt 100 ]; do
    curl -fsS "$BASE/json/version" >/dev/null 2>&1 && break
    i=$((i + 1))
    sleep 0.2
  done
fi

WS=$(curl -fsS "$BASE/json/version" 2>/dev/null \
  | tr -d '\n' \
  | sed -n 's/.*"webSocketDebuggerUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -z "$WS" ]; then
  echo "bob-browser: Chrome is not answering on $BASE." >&2
  echo "  If another Chrome already uses port $PORT, quit it and run this again" >&2
  echo "  so the new instance starts with --remote-allow-origins=$ORIGIN." >&2
  exit 1
fi

case "$APP" in
  *\?*) TARGET="$APP&cdp=$WS" ;;
  *) TARGET="$APP?cdp=$WS" ;;
esac

if [ "${BOB_NO_OPEN:-0}" = "1" ] || [ "${BOB_BROWSER_HEADLESS:-0}" = "1" ]; then
  printf '%s\n' "$TARGET"
  exit 0
fi

# Same user-data-dir: Chrome hands the URL to the running instance as a new tab.
"$CHROME" --user-data-dir="$PROFILE_DIR" "$TARGET" >/dev/null 2>&1 || true
printf 'bob-browser: opened %s\n' "$TARGET"
