#!/usr/bin/env bash
set -euo pipefail
[[ "$1" =~ ^([1-9]|[12][0-9]|30)$ ]]
sleep "${1}m"
# Keep denying execution even when the deadline expires during CLI installation.
while true; do
  sudo -n pkill -KILL -u codex-worker || true
  sleep 1
done
