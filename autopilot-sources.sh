#!/bin/bash
# autopilot-sources.sh — runs scan.mjs + apify-scan.mjs in parallel.
# Called by launchd; logs to ~/.career-ops/logs/.
set -e

REPO="$HOME/resume/career-ops"
LOG_DIR="$HOME/.career-ops/logs"
mkdir -p "$LOG_DIR"

cd "$REPO"

TS=$(date +%F-%H%M)

# Run both scanners in parallel; capture separate logs
node scan.mjs > "$LOG_DIR/scan-$TS.log" 2>&1 &
SCAN_PID=$!

node apify-scan.mjs > "$LOG_DIR/apify-$TS.log" 2>&1 &
APIFY_PID=$!

wait $SCAN_PID $APIFY_PID

echo "[$(date -Iseconds)] sources complete" >> "$LOG_DIR/sources.log"
