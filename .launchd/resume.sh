#!/bin/bash
# .launchd/resume.sh — resume autopilot
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist"
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist"
echo "Autopilot resumed."
launchctl list | grep career-ops
