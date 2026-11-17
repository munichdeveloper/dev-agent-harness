#!/usr/bin/env bash
# One Claude Code run as the isolated claude-worker account. The Anthropic key stays with a credential proxy of the
# runner account (src/claude-proxy.ts); the account may reach that proxy on 127.0.0.1 and, with `loopback`, its own
# loopback servers, and nothing else: no DNS, no other host, no IPv6.
set -euo pipefail
ACCOUNT=claude-worker
HOME_DIRECTORY=/home/claude-worker
[[ "$RUNNER_OS" == Linux ]]
[[ "$CLAUDE_CODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$HARNESS_MODEL" =~ ^claude-[a-zA-Z0-9._-]{1,93}$ ]]
[[ "$HARNESS_EFFORT" =~ ^(low|medium|high|xhigh|max)$ ]]
[[ "$HARNESS_LOOPBACK" == true || "$HARNESS_LOOPBACK" == false ]]
[[ "$TARGET" == "$(realpath -e -- "$TARGET")" && "$TARGET" =~ ^[A-Za-z0-9._/-]+$ ]]
[[ -d "$RUN_DIRECTORY" && ! -L "$RUN_DIRECTORY" ]]
if [[ -z "${HARNESS_ANTHROPIC_API_KEY:-}" ]]; then echo "The Claude worker needs the anthropic-api-key input" >&2; exit 1; fi

# Installed by the runner account while it still has network; the worker only executes it.
npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
CLAUDE="$(command -v claude)"

# Settings passed with --settings (highest precedence below managed settings); project settings, hooks and MCP servers
# of the checkout are not loaded, CLAUDE.md is.
node -e '
  const settings = { permissions: { deny: ["WebFetch", "WebSearch"] }, disableAllHooks: true,
    env: { DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } };
  require("node:fs").writeFileSync(process.argv[1], JSON.stringify(settings), { flag: "wx", mode: 0o644 });' "$RUN_DIRECTORY/claude-settings.json"

# The credential proxy: runner account, 127.0.0.1, port chosen by the kernel.
HARNESS_PROXY_PORT_FILE="$RUN_DIRECTORY/proxy.port" setsid node "$GITHUB_ACTION_PATH/dist/claude-proxy.js" \
  </dev/null >"$RUN_DIRECTORY/proxy.log" 2>&1 &
echo "$!" > "$RUN_DIRECTORY/proxy.pid"
unset HARNESS_ANTHROPIC_API_KEY
for _ in $(seq 1 50); do [[ -s "$RUN_DIRECTORY/proxy.port" ]] && break; sleep 0.2; done
PORT="$(tr -d '\n' < "$RUN_DIRECTORY/proxy.port")"
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]]

bash "$GITHUB_ACTION_PATH/scripts/claude-network.sh" "$PORT" "$HARNESS_LOOPBACK"

# Preflight: the worker reaches the proxy, but not the API host or any other address directly.
API_ADDRESS="$(getent ahostsv4 api.anthropic.com | awk 'NR==1 { print $1 }')"
worker() { sudo -n setpriv --reuid="$ACCOUNT" --regid="$ACCOUNT" --clear-groups --no-new-privs --bounding-set=-all \
  --inh-caps=-all --ambient-caps=-all env -i PATH="$PATH" HOME="$HOME_DIRECTORY" "$@"; }
worker timeout 5 bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$1"' _ "$PORT"
for address in "$API_ADDRESS" 1.1.1.1; do
  if [[ -n "$address" ]] && worker timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/443"' _ "$address" 2>/dev/null; then
    echo "Network isolation of the Claude worker failed" >&2; exit 1
  fi
done

STREAM="$RUN_DIRECTORY/claude-stream.jsonl"
set +e
(cd "$TARGET" && worker \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_API_KEY=harness-proxy-placeholder \
  DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false npm_config_offline=true \
  "$CLAUDE" --print --model "$HARNESS_MODEL" --effort "$HARNESS_EFFORT" \
    --permission-mode bypassPermissions --setting-sources user --settings "$RUN_DIRECTORY/claude-settings.json" \
    --strict-mcp-config --disallowedTools WebFetch WebSearch \
    --output-format stream-json --verbose --json-schema "$(cat "$RUN_DIRECTORY/message.schema.json")" \
    < "$RUN_DIRECTORY/prompt.txt" > "$STREAM")
STATUS=$?
set -e
sudo pkill -KILL -u "$ACCOUNT" || true
echo "Claude Code exited with $STATUS"
# A trace without tool inputs or outputs: which tools ran, in order.
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | "tool: \(.name)"' "$STREAM" 2>/dev/null | head -n 500 || true
# The final result line only; the worker cannot write here. collect-coding.sh validates it.
jq -c 'select(.type == "result")' "$STREAM" 2>/dev/null | tail -n 1 > "$RUN_DIRECTORY/claude.json" || true
jq -r '"result: \(.subtype) turns=\(.num_turns) cost_usd=\(.total_cost_usd)"' "$RUN_DIRECTORY/claude.json" 2>/dev/null || true
chmod 644 "$RUN_DIRECTORY/claude.json"
