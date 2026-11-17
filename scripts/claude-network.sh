#!/usr/bin/env bash
# Egress of the claude-worker account: the credential proxy on 127.0.0.1:<port>, with loopback also its own
# loopback servers (no DNS), and nothing else. A dedicated chain, so a self-hosted runner can remove it again.
set -euo pipefail
PORT="$1"; LOOPBACK="$2"
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ && ( "$LOOPBACK" == true || "$LOOPBACK" == false ) ]]
WORKER_UID="$(id -u claude-worker)"
for filter in iptables ip6tables; do
  sudo "$filter" -w -N HARNESS_CLAUDE 2>/dev/null || sudo "$filter" -w -F HARNESS_CLAUDE
  sudo "$filter" -w -D OUTPUT -m owner --uid-owner "$WORKER_UID" -j HARNESS_CLAUDE 2>/dev/null || true
  if [[ "$filter" == iptables ]]; then
    sudo "$filter" -w -A HARNESS_CLAUDE -o lo -d 127.0.0.1 -p tcp --dport "$PORT" -j ACCEPT
  fi
  if [[ "$LOOPBACK" == true ]]; then
    sudo "$filter" -w -A HARNESS_CLAUDE -o lo -p tcp --dport 53 -j REJECT
    sudo "$filter" -w -A HARNESS_CLAUDE -o lo -p udp --dport 53 -j REJECT
    sudo "$filter" -w -A HARNESS_CLAUDE -o lo -j ACCEPT
  fi
  sudo "$filter" -w -A HARNESS_CLAUDE -j REJECT
  sudo "$filter" -w -I OUTPUT -m owner --uid-owner "$WORKER_UID" -j HARNESS_CLAUDE
done
