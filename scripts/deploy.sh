#!/usr/bin/env bash
# scripts/deploy.sh — laptop-side deploy script.
# Stages files on the phone's /sdcard/ and prints the one-liner
# the user runs in Termux to finish the install (or update).
set -euo pipefail

# ---------- config ----------
SHERPA_VERSION="${SHERPA_VERSION:-v1.12.13}"
STT_PORT="${STT_PORT:-8178}"
ADMIN_PORT="${ADMIN_PORT:-8080}"
PHONE_TERMUX_HOME="/data/data/com.termux/files/home"
PHONE_PROJECT_DIR="grandpa-bob-bot"
MODEL_DIR_NAME="sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8"
STAGE_DIR="/sdcard/Download/grandpa-bob-bot-deploy"
GRANDMA_KAT_URL="${GRANDMA_KAT_URL:-https://github.com/hfxaiguy/grandma-kat.git}"
DESKTOP_IP="${DESKTOP_IP:-192.168.2.10}"

# ---------- helpers ----------
note() { printf '\033[1;36m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
adb_s() { adb shell "$@"; }
adb_x() { adb shell "$@" 2>&1 | tr -d '\r'; }

# ---------- preflight ----------
command -v adb    >/dev/null 2>&1 || die "adb not in PATH"
command -v curl   >/dev/null 2>&1 || die "curl not in PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not in PATH"
adb get-state >/dev/null 2>&1   || die "no ADB device"

DEVICE_MODEL=$(adb_x getprop ro.product.model)
DEVICE_ARCH=$(adb_x  getprop ro.product.cpu.abi)
DEVICE_SERIAL="${ADB_SERIAL:-$(adb get-serialno 2>/dev/null | tr -d '\r')}"
DEVICE_IP=$(adb_x ip -4 addr show wlan0 2>/dev/null | awk '/inet /{split($2,a,"/");print a[1]}') || true
[[ -n "$DEVICE_MODEL" ]] || die "could not read device model"
note "device: $DEVICE_MODEL ($DEVICE_ARCH)${DEVICE_IP:+ $DEVICE_IP}"

case "$DEVICE_ARCH" in
  arm64-v8a)   SHERPA_ASSET_GLOB="linux-aarch64-shared-cpu" ;;
  x86_64)      SHERPA_ASSET_GLOB="linux-x64-shared" ;;
  *)           die "unsupported arch: $DEVICE_ARCH" ;;
esac

# ---------- repo URL ----------
if [[ -z "${REPO_URL:-}" ]]; then
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
  [[ -z "$REMOTE_URL" ]] && die "no REPO_URL and no 'origin' remote"
  case "$REMOTE_URL" in
    git@github.com:*) REPO_URL="https://github.com/${REMOTE_URL#git@github.com:}" ;;
    *)               REPO_URL="$REMOTE_URL" ;;
  esac
fi
note "repo:   $REPO_URL"

# ---------- internet ----------
pkill -f 'gnirehtet run' 2>/dev/null || true
adb_s am force-stop com.genymobile.gnirehtet 2>/dev/null || true
sleep 2

phone_has_internet() {
  adb_x sh -c '
    ip route 2>/dev/null | grep -q "^default " && exit 0
    ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1 && exit 0
    exit 1
  '
}

if ! phone_has_internet; then
  echo
  echo "  ┌──────────────────────────────────────────────────────────────────┐"
  echo "  │  The phone has no internet. Connect to Wi-Fi or enable          │"
  echo "  │  mobile data — do NOT enable gnirehtet (it breaks DNS).         │"
  echo "  └──────────────────────────────────────────────────────────────────┘"
  echo
  for i in $(seq 120 -5 5); do
    phone_has_internet && break
    printf "\r  waiting for network... %2ds " "$i"
    sleep 5
  done
  phone_has_internet || die "phone still offline"
fi
note "phone online"

# ---------- stage files ----------
note "staging to $STAGE_DIR"
adb_s mkdir -p "$STAGE_DIR" >/dev/null

# .env template
cat > /tmp/gbot-env <<'ENV'
TELEGRAM_BOT_TOKEN=replace-me
ALLOWED_USER_IDS=replace-me
OLLAMA_API_KEY=replace-me
STT_BACKEND=parakeet
SHERPA_URL=ws://127.0.0.1:8178
STT_LANGUAGE=en
WORKSPACE_DIR=/data/data/com.termux/files/home/grandma-workspace
COMMS_DB_PATH=/data/data/com.termux/files/home/grandma-workspace/comms.db
ENV
adb push /tmp/gbot-env "$STAGE_DIR/.env.template" >/dev/null
rm /tmp/gbot-env

# models.json — single source of truth is the committed models.example.json.
# Copy it verbatim; the bot interpolates ${ENV_VAR} secrets at runtime.
note "staging models.json from models.example.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
adb push "$SCRIPT_DIR/../models.example.json" "$STAGE_DIR/models.json" >/dev/null

# sherpa-onnx tarball
SHERPA_TARBALL="sherpa-onnx-$SHERPA_ASSET_GLOB.tar.bz2"
if ! adb_s test -f "$STAGE_DIR/$SHERPA_TARBALL" 2>/dev/null; then
  note "downloading sherpa-onnx"
  RELEASE_JSON=$(curl -sf "https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/$SHERPA_VERSION")
  ASSET_URL=$(echo "$RELEASE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d['assets']:
    if a['name'].startswith('sherpa-onnx-$SHERPA_VERSION-$SHERPA_ASSET_GLOB') and a['name'].endswith('.tar.bz2'):
        print(a['browser_download_url']);break
") || true
  [[ -z "${ASSET_URL:-}" ]] && die "no sherpa asset matching $SHERPA_ASSET_GLOB"
  curl -sSfL -o /tmp/sherpa.tar.bz2 "$ASSET_URL"
  adb push /tmp/sherpa.tar.bz2 "$STAGE_DIR/$SHERPA_TARBALL" >/dev/null
  rm /tmp/sherpa.tar.bz2
fi

# Zipformer model tarball
MODEL_TARBALL="$MODEL_DIR_NAME.tar.bz2"
if ! adb_s test -f "$STAGE_DIR/$MODEL_TARBALL" 2>/dev/null; then
  note "downloading Zipformer model (~140 MB)"
  curl -sSfL -o /tmp/zipformer.tar.bz2 \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$MODEL_TARBALL"
  adb push /tmp/zipformer.tar.bz2 "$STAGE_DIR/$MODEL_TARBALL" >/dev/null
  rm /tmp/zipformer.tar.bz2
fi

# install.sh — substitute placeholders
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sed \
  -e "s|__STAGE_DIR__|$STAGE_DIR|g" \
  -e "s|__SHERPA_TARBALL_NAME__|$SHERPA_TARBALL|g" \
  -e "s|__MODEL_TARBALL_NAME__|$MODEL_TARBALL|g" \
  -e "s|__MODEL_DIR_NAME__|$MODEL_DIR_NAME|g" \
  -e "s|__PHONE_PROJECT_DIR__|$PHONE_PROJECT_DIR|g" \
  -e "s|__REPO_URL__|$REPO_URL|g" \
  -e "s|__STT_PORT__|$STT_PORT|g" \
  -e "s|__ADMIN_PORT__|$ADMIN_PORT|g" \
  -e "s|__DESKTOP_IP__|$DESKTOP_IP|g" \
  "$SCRIPT_DIR/install.sh" > /tmp/gbot-install.sh
adb push /tmp/gbot-install.sh "$STAGE_DIR/install.sh" >/dev/null
rm /tmp/gbot-install.sh

# ---------- run install on the phone ----------
note "staged — run this on the phone:"
echo
echo "  sh /sdcard/Download/grandpa-bob-bot-deploy/install.sh"
echo

# ---------- summary ----------
cat <<EOF

$(printf '\033[1;32m')✓ staged$(printf '\033[0m')

phone : $DEVICE_MODEL
stage : $STAGE_DIR
admin : http://${DEVICE_IP:-<phone-ip>}:$ADMIN_PORT  (starts with the bot)

$(printf '\033[1;33m')Next: open Termux on the phone and run:$(printf '\033[0m')

  sh /sdcard/Download/grandpa-bob-bot-deploy/install.sh

It will:
  - fix DNS (so git/npm work)
  - install packages (skipped if already installed)
  - git pull the latest code
  - npm install
  - extract sherpa-onnx + model
  - set up workspace sync (git remote to desktop)
  - start sherpa-onnx + bot (admin UI on port $ADMIN_PORT)

EOF
