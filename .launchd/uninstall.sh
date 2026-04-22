#!/bin/bash
# .launchd/uninstall.sh — unload + remove plists (keeps data/)
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist" 2>/dev/null || true
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist" 2>/dev/null || true
rm -f "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist"
rm -f "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist"
echo "Autopilot uninstalled. data/ preserved."
