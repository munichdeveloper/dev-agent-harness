#!/usr/bin/env bash
# Records the token usage of the run as the runner account, after the agent stopped, also when it failed or timed out.
set -euo pipefail
[[ -d "$RUN_DIRECTORY" && ! -L "$RUN_DIRECTORY" ]]
if [[ "${HARNESS_WORKER:-}" == codex ]]; then
  # The newest session log of this run; the worker wrote it, so it is only read for its token counts.
  SESSION="$(sudo -n find /home/codex-worker/.codex/sessions -type f -name 'rollout-*.jsonl' -newer "$RUN_DIRECTORY/request.json" \
    -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2- || true)"
  if [[ -n "$SESSION" ]]; then sudo -n tail -n 50000 -- "$SESSION" > "$RUN_DIRECTORY/codex-session.jsonl" || true; fi
fi
node "$GITHUB_ACTION_PATH/dist/coding-cli.js" usage
