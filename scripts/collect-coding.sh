#!/usr/bin/env bash
set -euo pipefail
ACCOUNT="${HARNESS_ACCOUNT:-codex-worker}"
[[ "$ACCOUNT" == codex-worker || "$ACCOUNT" == claude-worker ]]
sudo pkill -KILL -u "$ACCOUNT" || true
# Drop capabilities as root, then switch identity. Git filters are untrusted code.
sudo setpriv --reuid="$ACCOUNT" --regid="$ACCOUNT" --clear-groups \
  --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  env -i PATH="$PATH" RUNNER_TEMP="$RUNNER_TEMP" \
  HARNESS_EXECUTION_ID="$HARNESS_EXECUTION_ID" HARNESS_WORKSPACE="$HARNESS_WORKSPACE" \
  node "$GITHUB_ACTION_PATH/dist/coding-cli.js" collect
sudo pkill -KILL -u "$ACCOUNT" || true
[[ -f "$RUN_DIRECTORY/output/artifact.json" && ! -L "$RUN_DIRECTORY/output/artifact.json" ]]
[[ "$(wc -c < "$RUN_DIRECTORY/output/artifact.json")" -le 7000000 ]]
cp "$RUN_DIRECTORY/output/artifact.json" "$RUN_DIRECTORY/artifact.json"
