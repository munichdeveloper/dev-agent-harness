#!/usr/bin/env bash
# Stops the credential proxy and removes the worker's network rules; disposable runners lose both anyway.
set -uo pipefail
if [[ -n "${RUN_DIRECTORY:-}" && -f "$RUN_DIRECTORY/proxy.pid" ]]; then
  PID="$(tr -d '\n' < "$RUN_DIRECTORY/proxy.pid")"
  if [[ "$PID" =~ ^[0-9]+$ ]]; then kill -- "-$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true; fi
fi
if WORKER_UID="$(id -u claude-worker 2>/dev/null)"; then
  for filter in iptables ip6tables; do
    while sudo "$filter" -w -D OUTPUT -m owner --uid-owner "$WORKER_UID" -j HARNESS_CLAUDE 2>/dev/null; do :; done
    sudo "$filter" -w -F HARNESS_CLAUDE 2>/dev/null || true
    sudo "$filter" -w -X HARNESS_CLAUDE 2>/dev/null || true
  done
fi
exit 0
