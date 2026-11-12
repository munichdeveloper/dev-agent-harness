#!/usr/bin/env bash
set -euo pipefail
export GITHUB_ACTION_PATH="$PWD"
export TARGET="$RUNNER_TEMP/coding-home-target"
export HARNESS_PROFILE=':workspace'
MARKERS="$RUNNER_TEMP/coding-home-markers"
CONTROL_HOME="$RUNNER_TEMP/coding-home-control"
refused() { if "$@"; then echo "Unexpectedly allowed: $*" >&2; exit 1; fi; }
sudo adduser --system --home /home/codex-worker --shell /bin/bash --group codex-worker
sudo chmod o+x /home/runner /home/runner/work
sudo chmod o+x /home/codex-worker
sudo install -d -o codex-worker -g codex-worker "$MARKERS" "$CONTROL_HOME"
# The base commit of a target repository may carry Codex configuration that starts a host process.
mkdir -p "$TARGET/.codex"
git -C "$TARGET" init
printf '[mcp_servers.x]\ncommand = "bash"\nargs = ["-c", "touch %s/started"]\n' "$MARKERS" > "$TARGET/.codex/config.toml"
ln -sfn "$TARGET" "$RUNNER_TEMP/coding-home-link"
sudo chown -R codex-worker:codex-worker "$TARGET"
TARGET="$RUNNER_TEMP/coding-home-link" refused bash scripts/coding-home.sh
HARNESS_PROFILE=other refused bash scripts/coding-home.sh
bash scripts/coding-home.sh
[[ "$(cat /home/codex-worker/.codex/config.toml)" == "$(printf '[projects."%s"]\ntrust_level = "untrusted"' "$TARGET")" ]]
# Bubblewrap prerequisite on hosted Ubuntu images; the pinned Codex Action sets the same values later.
sudo sysctl -qw kernel.unprivileged_userns_clone=1 2>/dev/null || true
sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0 2>/dev/null || true
npm install -g @openai/codex@0.167.0
# Control: with a Codex home that lacks the entry, a real codex exec trusts the checkout and starts the server.
CODEX_HOME="$CONTROL_HOME" node scripts/test-loopback-exec.mjs
sudo test -e "$MARKERS/started"
sudo rm "$MARKERS/started"
# With the seeded home the same run works and the checkout's configuration is not executed.
node scripts/test-loopback-exec.mjs
refused sudo test -e "$MARKERS/started"
refused grep -q '"trusted"' /home/codex-worker/.codex/config.toml
