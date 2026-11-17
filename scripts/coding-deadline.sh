#!/usr/bin/env bash
set -euo pipefail
[[ "$1" =~ ^([1-9]|[12][0-9]|30)$ ]]
ACCOUNT="${2:-codex-worker}"
[[ "$ACCOUNT" == codex-worker || "$ACCOUNT" == claude-worker ]]
sleep "${1}m"
# Keep denying execution even when the deadline expires during CLI installation.
while true; do
  sudo -n pkill -KILL -u "$ACCOUNT" || true
  sleep 1
done
