#!/bin/bash
# .launchd/setup.sh — install launchd plists for autopilot
set -e

REPO="$HOME/resume/career-ops"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCHD_DIR"
mkdir -p "$HOME/.career-ops/logs"

# Unload first (ignore errors if not previously loaded)
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist" 2>/dev/null || true
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist" 2>/dev/null || true

# Copy plists
cp "$REPO/.launchd/com.marshmallow.career-ops.sources.plist" "$LAUNCHD_DIR/"
cp "$REPO/.launchd/com.marshmallow.career-ops.digest.plist" "$LAUNCHD_DIR/"

# Load
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist"
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist"

echo "Autopilot installed. Verifying:"
launchctl list | grep career-ops || echo "(not loaded — check logs at ~/.career-ops/logs/)"

echo ""
echo "Logs directory: $HOME/.career-ops/logs/"
echo "Next scheduled run at :00 of the next hour (7, 9, 11, 13, 15, 17, 19, or 21 PST)"
echo "Pause:   bash .launchd/pause.sh"
echo "Resume:  bash .launchd/resume.sh"
