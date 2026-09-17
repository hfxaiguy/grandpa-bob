#!/data/data/com.termux/files/usr/bin/sh
# scripts/force-sync-workspace.sh
#
# Run on the phone (inside Termux). Hard-forces the local workspace to
# exactly match the desktop copy served over git-daemon, discarding any
# local edits on the phone. Idempotent.
#
# The desktop's git-daemon (systemd unit) serves a bare repo:
#   git clone  ->  git://192.168.2.10/grandma-workspace.git   (branch master)
#
# Usage:
#   sh scripts/force-sync-workspace.sh               # uses defaults
#   DESKTOP_IP=192.168.2.10 sh scripts/force-sync-workspace.sh
#
# Environment overrides:
#   DESKTOP_IP   gateway IP to pull from (default 192.168.2.10)
#   WORKSPACE    workspace dir (default $HOME/grandma-workspace)
set -eu

# ---------- defaults ----------
DESKTOP_IP="${DESKTOP_IP:-192.168.2.10}"
WORKSPACE="${WORKSPACE:-$HOME/grandma-workspace}"
SYNC_URL="git://$DESKTOP_IP/grandma-workspace.git"

# ---------- logging ----------
note() { echo "[+] $*"; }
warn() { echo "[!] $*"; }
die()  { echo "[x] $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git not found (run in Termux)"

# ---------- preflight ----------
if [ ! -d "$WORKSPACE/.git" ]; then
  warn "no git repo at $WORKSPACE — initialising"
  mkdir -p "$WORKSPACE"
  git -C "$WORKSPACE" init
  git -C "$WORKSPACE" config user.name "grandpa-bob-bot"
  git -C "$WORKSPACE" config user.email "grandpa-bob-bot@localhost"
fi

# ---------- point the sync remote at the desktop ----------
if ! git -C "$WORKSPACE" remote get-url sync >/dev/null 2>&1; then
  note "adding sync remote ($SYNC_URL)"
  git -C "$WORKSPACE" remote add sync "$SYNC_URL"
else
  note "pointing sync remote at $SYNC_URL"
  git -C "$WORKSPACE" remote set-url sync "$SYNC_URL"
fi

# ---------- fetch the desktop's master ----------
note "fetching from desktop"
if ! git -C "$WORKSPACE" fetch sync master; then
  die "could not fetch from $SYNC_URL (desktop git-daemon running?)"
fi

# ---------- force-reset local workspace to match ----------
note "resetting workspace to match desktop (discarding local changes)"
git -C "$WORKSPACE" reset --hard FETCH_HEAD || die "hard reset failed"

# Remove stray untracked files so the tree is pixel-identical, but keep
# the grandma-kat runtime log and any sqlite WAL so a running bot isn't broken.
git -C "$WORKSPACE" clean -fd \
  -e "logs/grandma-kat.db*" \
  -e "*.db-wal" -e "*.db-shm"

# ---------- done ----------
note "workspace sync forced. HEAD is now:"
git -C "$WORKSPACE" log -1 --oneline
note "done"