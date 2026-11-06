#!/usr/bin/env bash
set -euo pipefail
sudo pkill -KILL -u codex-worker || true
# Drop capabilities as root, then switch identity. Git filters are untrusted code.
sudo setpriv --reuid=codex-worker --regid=codex-worker --clear-groups \
  --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  env -i PATH="$PATH" RUNNER_TEMP="$RUNNER_TEMP" \
  HARNESS_EXECUTION_ID="$HARNESS_EXECUTION_ID" HARNESS_WORKSPACE="$HARNESS_WORKSPACE" \
  node "$GITHUB_ACTION_PATH/dist/coding-cli.js" collect
sudo pkill -KILL -u codex-worker || true
[[ -f "$RUN_DIRECTORY/output/artifact.json" && ! -L "$RUN_DIRECTORY/output/artifact.json" ]]
[[ "$(wc -c < "$RUN_DIRECTORY/output/artifact.json")" -le 7000000 ]]
cp "$RUN_DIRECTORY/output/artifact.json" "$RUN_DIRECTORY/artifact.json"
