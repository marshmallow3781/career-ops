#!/bin/bash
# .launchd/pause.sh — pause autopilot (state preserved)
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist" 2>/dev/null || true
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist" 2>/dev/null || true
echo "Autopilot paused. State in data/ preserved. Resume with .launchd/resume.sh"
