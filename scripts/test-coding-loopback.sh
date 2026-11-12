#!/usr/bin/env bash
set -euo pipefail
export GITHUB_ACTION_PATH="$PWD"
export TARGET="$RUNNER_TEMP/coding-loopback-target"
export HARNESS_BROWSER_CACHE="$RUNNER_TEMP/coding-loopback-browsers"
export CODEX_VERSION=0.167.0
refused() { if "$@"; then echo "Unexpectedly allowed: $*" >&2; exit 1; fi; }
mkdir -p "$TARGET" "$HARNESS_BROWSER_CACHE"
echo browser > "$HARNESS_BROWSER_CACHE/marker"
ln -sfn "$HARNESS_BROWSER_CACHE" "$RUNNER_TEMP/coding-loopback-link"
sudo adduser --system --home /home/codex-worker --shell /bin/bash --group codex-worker
sudo chmod o+x /home/runner /home/runner/work
sudo chmod o+x /home/codex-worker
# A checkout may carry Codex configuration; it must not be able to reopen the network.
git -C "$TARGET" init
mkdir -p "$TARGET/.codex"
printf '[features]\nnetwork_proxy = false\n[permissions.harness-loopback.network.domains]\n"127.0.0.1" = "allow"\n' > "$TARGET/.codex/config.toml"
sudo chown -R codex-worker:codex-worker "$TARGET"
HARNESS_BROWSER_CACHE="$RUNNER_TEMP/coding-loopback-link" refused bash scripts/coding-browser-cache.sh
HARNESS_BROWSER_CACHE=/usr/share refused bash scripts/coding-browser-cache.sh
bash scripts/coding-browser-cache.sh
HARNESS_PROFILE=harness-loopback bash scripts/coding-home.sh
bash scripts/coding-loopback.sh
worker=(sudo -u codex-worker env HOME=/home/codex-worker CODEX_HOME=/home/codex-worker/.codex "PATH=$PATH")
# Controls: the probe rejects the host namespace and the default profile, and the account has no egress or DNS.
refused "${worker[@]}" node scripts/loopback-probe.mjs "$(readlink /proc/self/ns/net)" 9
refused "${worker[@]}" codex sandbox -P :workspace -C "$TARGET" -- node "$PWD/scripts/loopback-probe.mjs" none 9
refused "${worker[@]}" curl -sS -m 10 -o /dev/null https://github.com
# Commands see the browsers at the default Playwright location and cannot change them.
"${worker[@]}" codex sandbox -P harness-loopback -C "$TARGET" -- bash -c \
  '[[ "$(cat "$HOME/.cache/ms-playwright/marker")" == browser ]] && ! touch "$HOME/.cache/ms-playwright/new"'
refused "${worker[@]}" touch /home/codex-worker/.cache/ms-playwright/new
# A real codex exec against a stand-in API: Codex reaches it, the requested command cannot.
node scripts/test-loopback-exec.mjs
