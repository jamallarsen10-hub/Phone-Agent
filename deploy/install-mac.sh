#!/bin/bash
# Installs Phone Agent's automatic confirmations/reminders as an always-on
# background service on Jamal's Mac.
#
#   bash deploy/install-mac.sh             install (or update) and start it
#   bash deploy/install-mac.sh --dry-run   show what it would do, change nothing
#   bash deploy/install-mac.sh --uninstall stop it and remove the service
#
# What it sets up:
#   - LaunchAgent com.jamal.followup-auto: starts at login, restarts if it stops
#   - caffeinate -s: the Mac doesn't sleep while plugged in (lid must stay open)
#   - logs in ~/pa-live/logs
# What it never does: read, write or print your Notion key or any other secret.
# Whether texts really go out is still decided by "mode": "auto" in config.json;
# without it the service runs as a dry run and texts no one.
set -euo pipefail

LABEL="com.jamal.followup-auto"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO/src/cli.js"
DATA="${PHONE_AGENT_DATA:-$HOME/pa-live/data}"
LOGS="$HOME/pa-live/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
DRY=0

case "${1:-}" in
  --dry-run) DRY=1 ;;
  --uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL. Your leads and settings in $DATA are untouched."
    exit 0 ;;
  "") ;;
  *) echo "Unknown option $1"; exit 2 ;;
esac

[ "$(uname)" = "Darwin" ] || { echo "This installer is for the Mac."; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node isn't installed. Get it from nodejs.org, then run this again."; exit 1; }
[ -f "$CLI" ] || { echo "Can't find $CLI"; exit 1; }

# Settings check (keys are only tested for presence, never printed).
CFG="$DATA/config.json"
mode="missing"; token="missing"
if [ -f "$CFG" ]; then
  mode="$("$NODE" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.mode||"drafts")}catch{console.log("unreadable")}' "$CFG")"
  token="$("$NODE" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.notionToken?"set":"missing")}catch{console.log("missing")}' "$CFG")"
fi

plist_xml() {
cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>$NODE</string><string>$CLI</string><string>auto</string><string>--live</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PHONE_AGENT_DATA</key><string>$DATA</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TZ</key><string>America/New_York</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- After a failed text, wait 10 minutes before trying again, so a broken
       Messages app can't burn through the queue. A failed text is never resent. -->
  <key>ThrottleInterval</key><integer>600</integer>
  <key>StandardOutPath</key><string>$LOGS/auto.log</string>
  <key>StandardErrorPath</key><string>$LOGS/auto.err.log</string>
</dict>
</plist>
XML
}

echo "Phone Agent auto sender"
echo "  code:     $REPO"
echo "  leads:    $DATA"
echo "  node:     $NODE"
echo "  mode:     $mode"
echo "  Notion:   $token"

if [ "$DRY" = 1 ]; then
  echo; echo "--dry-run: would write $PLIST:"; echo; plist_xml; exit 0
fi

mkdir -p "$DATA" "$LOGS" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/pa-live" "$DATA" 2>/dev/null || true
[ -f "$CFG" ] && chmod 600 "$CFG"
plist_xml > "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"
sleep 3

echo
if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q "state = running"; then
  echo "Running. It starts by itself at login and keeps the Mac awake while plugged in."
else
  echo "Installed but not running yet. Check $LOGS/auto.err.log"
fi
[ "$token" = "set" ] || echo "Next: add your Notion key to $CFG as \"notionToken\" (see README), then run this again."
[ "$mode" = "auto" ] || echo "Dry run only: nothing is texted until $CFG has \"mode\": \"auto\"."
echo "First real text: macOS asks to let node control Messages. Click OK."
echo "Keep the lid open and the charger in. A closed lid puts a MacBook to sleep."
