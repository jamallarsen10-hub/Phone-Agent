#!/bin/bash
# Keeps Phone Agent's auto sender (confirmations, reminders, receptionist,
# delivery check) running on Jamal's Mac without anyone touching it.
#
#   bash deploy/install-mac.sh             install (or update) and start it
#   bash deploy/install-mac.sh --dry-run   show what it would do, change nothing
#   bash deploy/install-mac.sh --uninstall stop it and remove the login item
#
# Why Terminal and not a hidden background service: the receptionist reads
# replies from the Messages database, which macOS only allows for apps with Full
# Disk Access. Terminal already has it. Giving it to `node` instead would hand it
# to every Node program on the Mac, including Mac Remote's coding agent, which
# its RISK-BRIEF forbids. So the launcher runs in a Terminal window that:
#   - opens by itself at login (a Login Item)
#   - only ever runs one copy (a second double-click just says it's running)
#   - restarts the sender 10 minutes after it stops (a failed text is never resent)
#   - keeps the Mac awake while plugged in (caffeinate -is)
#   - logs to ~/pa-live/logs/auto.log
# It never reads, writes or prints the Notion key or any other secret.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${PHONE_AGENT_DATA:-$HOME/pa-live/data}"
OUT="${PHONE_AGENT_OUT:-$HOME/pa-live/out}"
LOGS="$HOME/pa-live/logs"
LAUNCHER="$HOME/Start Phone Agent.command"
ITEM="Start Phone Agent.command"
DRY=0

case "${1:-}" in
  --dry-run) DRY=1 ;;
  --uninstall)
    osascript -e "tell application \"System Events\" to delete (every login item whose name is \"$ITEM\")" >/dev/null 2>&1 || true
    pkill -f "cli.js auto --live" 2>/dev/null || true
    echo "Stopped the sender and removed the login item. Leads and settings in $DATA are untouched."
    exit 0 ;;
  "") ;;
  *) echo "Unknown option $1"; exit 2 ;;
esac

[ "$(uname)" = "Darwin" ] || { echo "This installer is for the Mac."; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node isn't installed. Get it from nodejs.org, then run this again."; exit 1; }

launcher() {
cat <<SH
#!/bin/zsh
# Phone Agent: confirmations, reminders, receptionist, delivery check.
# Written by deploy/install-mac.sh. Opens at login. Close this window to stop it.
export PHONE_AGENT_DATA="$DATA" PHONE_AGENT_OUT="$OUT" TZ=America/New_York
LOCK="$HOME/pa-live/auto.lock"
mkdir -p "$LOGS"
# One copy only. mkdir is atomic, so two windows opening at once can't both win.
if ! mkdir "\$LOCK" 2>/dev/null; then
  OLD="\$(cat "\$LOCK/pid" 2>/dev/null)"
  if [ -n "\$OLD" ] && kill -0 "\$OLD" 2>/dev/null; then
    echo "Phone Agent is already running (pid \$OLD). Nothing to do."
    sleep 4; exit 0
  fi
  rm -rf "\$LOCK"; mkdir "\$LOCK" || { echo "Another copy is starting. Nothing to do."; sleep 4; exit 0; }
fi
echo \$\$ > "\$LOCK/pid"
stop_all() { pkill -f "cli.js auto --live" 2>/dev/null; rm -rf "\$LOCK"; exit 0; }
trap stop_all INT TERM HUP
trap 'rm -rf "\$LOCK"' EXIT
cd "$REPO" || exit 1
while true; do
  echo "\$(date '+%F %T') starting Phone Agent" | tee -a "$LOGS/auto.log"
  /usr/bin/caffeinate -is "$NODE" src/cli.js auto --live 2>&1 | tee -a "$LOGS/auto.log"
  echo "\$(date '+%F %T') Phone Agent stopped. Restarting in 10 minutes. A failed text is never resent." | tee -a "$LOGS/auto.log"
  sleep 600
done
SH
}

echo "Phone Agent always-on"
echo "  code:     $REPO"
echo "  leads:    $DATA"
echo "  launcher: $LAUNCHER (opens at login)"
if [ "$DRY" = 1 ]; then echo; launcher; exit 0; fi

mkdir -p "$DATA" "$OUT" "$LOGS"
chmod 700 "$HOME/pa-live" "$DATA" 2>/dev/null || true
[ -f "$DATA/config.json" ] && chmod 600 "$DATA/config.json"
[ -f "$LAUNCHER" ] && cp "$LAUNCHER" "$HOME/pa-live/Start Phone Agent.command.bak"
launcher > "$LAUNCHER"
chmod +x "$LAUNCHER"

# One copy only: stop any sender started by hand, then start the new launcher.
pkill -f "Start Phone Agent.command" 2>/dev/null || true
pkill -f "cli.js auto --live" 2>/dev/null || true
rm -rf "$HOME/pa-live/auto.lock" "$HOME/pa-live/auto.pid"
sleep 2

# macOS may ask once to let this Terminal control System Events. Don't wait forever on it.
with_timeout() { "$@" & local p=$!; ( sleep 60; kill $p 2>/dev/null ) & local w=$!; wait $p; local r=$?; kill $w 2>/dev/null; return $r; }
with_timeout osascript -e "tell application \"System Events\" to delete (every login item whose name is \"$ITEM\")" >/dev/null 2>&1 || true
if with_timeout osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$LAUNCHER\", hidden:false}" >/dev/null 2>&1; then
  echo "Opens by itself at login."
else
  echo "Couldn't add the login item. Add it by hand: System Settings > General > Login Items > + > $LAUNCHER"
fi
open -a Terminal "$LAUNCHER"
echo "Started in a Terminal window. Keep the charger in and the lid open."
