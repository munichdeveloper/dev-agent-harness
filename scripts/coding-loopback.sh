#!/usr/bin/env bash
# Opt-in: let the worker's commands bind and connect on loopback while all other network stays closed.
set -euo pipefail
CODEX_HOME=/home/codex-worker/.codex
WORKER_UID="$(id -u codex-worker)"
# Backstop below Codex for every process of the account: loopback only, and no local DNS forwarder.
# Rules are inserted at the top, so the last one inserted is evaluated first.
for filter in iptables ip6tables; do
  sudo "$filter" -w -I OUTPUT -m owner --uid-owner "$WORKER_UID" -j REJECT
  sudo "$filter" -w -I OUTPUT -o lo -m owner --uid-owner "$WORKER_UID" -j ACCEPT
  sudo "$filter" -w -I OUTPUT -o lo -p tcp --dport 53 -m owner --uid-owner "$WORKER_UID" -j REJECT
  sudo "$filter" -w -I OUTPUT -o lo -p udp --dport 53 -m owner --uid-owner "$WORKER_UID" -j REJECT
done
sudo install -d -o codex-worker -g codex-worker -m 755 "$CODEX_HOME"
# codex exec trusts a writable checkout by default and would then load its .codex/config.toml,
# which can switch managed networking off. Mark this checkout untrusted explicitly.
[[ "$TARGET" == "$(realpath -e -- "$TARGET")" && "$TARGET" =~ ^[A-Za-z0-9._/-]+$ ]]
{ cat "$GITHUB_ACTION_PATH/scripts/loopback.config.toml"; printf '\n[projects."%s"]\ntrust_level = "untrusted"\n' "$TARGET"; } |
  sudo tee "$CODEX_HOME/config.toml" >/dev/null
sudo chmod 444 "$CODEX_HOME/config.toml"
# The pinned Codex Action only prepares the proxy server-info file when it creates this directory itself.
if [[ ! -e "$CODEX_HOME/$GITHUB_RUN_ID.json" ]]; then
  sudo touch "$CODEX_HOME/$GITHUB_RUN_ID.json"
  sudo chmod 666 "$CODEX_HOME/$GITHUB_RUN_ID.json"
fi
# Bubblewrap prerequisite on hosted Ubuntu images; the pinned Codex Action sets the same values later.
sudo sysctl -qw kernel.unprivileged_userns_clone=1 2>/dev/null || true
sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0 2>/dev/null || true
npm install -g "@openai/codex@$CODEX_VERSION"
node "$GITHUB_ACTION_PATH/scripts/loopback-probe.mjs"
