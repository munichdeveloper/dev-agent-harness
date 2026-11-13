#!/usr/bin/env bash
# Opt-in: let the worker's commands bind and connect on loopback while all other network stays closed.
# Runs after coding-home.sh, which seeds the loopback profile and marks the checkout untrusted.
set -euo pipefail
WORKER_UID="$(id -u codex-worker)"
# Backstop below Codex for every process of the account: loopback only, and no local DNS forwarder.
# Rules are inserted at the top, so the last one inserted is evaluated first.
for filter in iptables ip6tables; do
  sudo "$filter" -w -I OUTPUT -m owner --uid-owner "$WORKER_UID" -j REJECT
  sudo "$filter" -w -I OUTPUT -o lo -m owner --uid-owner "$WORKER_UID" -j ACCEPT
  sudo "$filter" -w -I OUTPUT -o lo -p tcp --dport 53 -m owner --uid-owner "$WORKER_UID" -j REJECT
  sudo "$filter" -w -I OUTPUT -o lo -p udp --dport 53 -m owner --uid-owner "$WORKER_UID" -j REJECT
done
sudo install -d -o root -g root -m 755 /etc/codex-worker
sudo install -o root -g root -m 444 "$GITHUB_ACTION_PATH/scripts/loopback-commands.bash" /etc/codex-worker/commands.bash
# Bubblewrap prerequisite on hosted Ubuntu images; the pinned Codex Action sets the same values later.
sudo sysctl -qw kernel.unprivileged_userns_clone=1 2>/dev/null || true
sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0 2>/dev/null || true
npm install -g "@openai/codex@$CODEX_VERSION"
node "$GITHUB_ACTION_PATH/scripts/loopback-probe.mjs"
