#!/usr/bin/env bash
# Every run: seed the worker's Codex home so that the checkout is never a trusted Codex project.
set -euo pipefail
CODEX_HOME=/home/codex-worker/.codex
[[ "$HARNESS_PROFILE" == ':workspace' || "$HARNESS_PROFILE" == harness-loopback ]]
# codex exec trusts a writable checkout by default and would then load its .codex/config.toml. That file
# can start host processes outside the command sandbox (MCP servers, hooks) and switch managed networking off.
[[ "$TARGET" == "$(realpath -e -- "$TARGET")" && "$TARGET" =~ ^[A-Za-z0-9._/-]+$ ]]
sudo install -d -o codex-worker -g codex-worker -m 755 "$CODEX_HOME"
{
  if [[ "$HARNESS_PROFILE" == harness-loopback ]]; then cat "$GITHUB_ACTION_PATH/scripts/loopback.config.toml"; echo; fi
  printf '[projects."%s"]\ntrust_level = "untrusted"\n' "$TARGET"
} | sudo tee "$CODEX_HOME/config.toml" >/dev/null
sudo chmod 444 "$CODEX_HOME/config.toml"
# The pinned Codex Action only prepares the proxy server-info file when it creates this directory itself.
if [[ ! -e "$CODEX_HOME/$GITHUB_RUN_ID.json" ]]; then
  sudo touch "$CODEX_HOME/$GITHUB_RUN_ID.json"
  sudo chmod 666 "$CODEX_HOME/$GITHUB_RUN_ID.json"
fi
