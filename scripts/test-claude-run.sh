#!/usr/bin/env bash
# A real Claude Code run through scripts/claude-run.sh against a stand-in API on loopback: the worker account edits
# the checkout, cannot reach the network, never sees the key, and the result is collected. No API credentials needed.
set -euo pipefail
export GITHUB_ACTION_PATH="$PWD"
export HARNESS_EXECUTION_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export HARNESS_WORKSPACE="$RUNNER_TEMP/claude-run-target" TARGET="$RUNNER_TEMP/claude-run-target"
export RUN_DIRECTORY="$RUNNER_TEMP/harness-$HARNESS_EXECUTION_ID"
export HARNESS_ACCOUNT=claude-worker CLAUDE_CODE_VERSION=2.1.318 HARNESS_MODEL=claude-opus-5-5 HARNESS_EFFORT=high HARNESS_LOOPBACK=false
STAND_IN="$RUNNER_TEMP/stand-in"; mkdir -p "$STAND_IN"; : > "$STAND_IN/requests.jsonl"
node scripts/fixtures/claude/stand-in-api.mjs "$STAND_IN/requests.jsonl" "$STAND_IN/port" </dev/null >/dev/null 2>&1 &
STAND_IN_PID=$!; trap 'kill "$STAND_IN_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [[ -s "$STAND_IN/port" ]] && break; sleep 0.2; done
export HARNESS_PROXY_UPSTREAM="http://127.0.0.1:$(tr -d '\n' < "$STAND_IN/port")"
mkdir -p "$TARGET"
git -C "$TARGET" init
# Checkout configuration must not load: a hook that would leave a marker, and an MCP server.
mkdir -p "$TARGET/.claude"
printf '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"touch /tmp/claude-hook-ran"}]}]}}\n' > "$TARGET/.claude/settings.json"
printf '{"mcpServers":{"x":{"command":"touch","args":["/tmp/claude-mcp-ran"]}}}\n' > "$TARGET/.mcp.json"
git -C "$TARGET" add . && git -C "$TARGET" -c user.name=CI -c user.email=ci@example.invalid commit -m base
BASE_SHA="$(git -C "$TARGET" rev-parse HEAD)"; export BASE_SHA
HARNESS_REQUEST="$(node --input-type=module -e '
  console.log(JSON.stringify({contractVersion:"3.0", executionId:process.env.HARNESS_EXECUTION_ID, worker:"claude",
    task:{id:"fixture:1",version:"b".repeat(64),description:"Stand-in run",acceptanceCriteria:["Collected"],contextReferences:[]},
    allowedActions:["edit_workspace","run_commands"],baseSha:process.env.BASE_SHA, model:"claude-opus-5-5",effort:"high",
    limits:{timeoutMinutes:5,maxFiles:100,maxPatchBytes:5000000,maxCostUsd:5}}));')"; export HARNESS_REQUEST
GITHUB_OUTPUT="$RUNNER_TEMP/prepare-output" node dist/coding-cli.js prepare
grep -qx 'account=claude-worker' "$RUNNER_TEMP/prepare-output"
grep -qx 'budget=5' "$RUNNER_TEMP/prepare-output"
sudo adduser --system --home /home/claude-worker --shell /bin/bash --group claude-worker
for directory in /home/runner /home/runner/work /home/claude-worker; do [[ -d "$directory" ]] && sudo chmod o+x "$directory"; done
sudo chown -R claude-worker:claude-worker "$TARGET"
chmod o+rx "$RUN_DIRECTORY"
sudo install -d -o claude-worker -g claude-worker "$RUN_DIRECTORY/output"
# HARNESS_TEST_CREDENTIAL=oauth: the same run with a subscription's OAuth token instead of an API key.
SECRET=sk-ant-fixture-not-a-real-key-0123456789
if [[ "${HARNESS_TEST_CREDENTIAL:-api-key}" == oauth ]]; then
  HARNESS_BUDGET_USD=5 HARNESS_CLAUDE_OAUTH_TOKEN="$SECRET" bash scripts/claude-run.sh
else
  HARNESS_BUDGET_USD=5 HARNESS_ANTHROPIC_API_KEY="$SECRET" bash scripts/claude-run.sh
fi
bash scripts/collect-coding.sh
HARNESS_WORKER=claude bash scripts/record-usage.sh
bash scripts/claude-cleanup.sh
node --input-type=module -e '
  import fs from "node:fs"; import assert from "node:assert/strict";
  const value = JSON.parse(fs.readFileSync(process.env.RUN_DIRECTORY + "/artifact.json"));
  assert.equal(value.result.status, "success"); assert.equal(value.result.summary, "Stand-in run finished");
  const files = Object.fromEntries(value.changes.map(c => [c.path, Buffer.from(c.content, "base64").toString()]));
  assert.equal(files["claude.txt"], "claude\n"); assert.equal(files["network.txt"], "closed\n");
  const usage = JSON.parse(fs.readFileSync(process.env.RUN_DIRECTORY + "/usage.json"));
  assert.equal(usage.source, "proxy"); assert.equal(usage.requests, 3); assert.equal(usage.tokens.output, 3);
  assert.equal(usage.outcome, "success"); assert.equal(usage.budgetUsd, 5); assert.equal(usage.budgetReached, false);
  const requests = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(requests.length, 3);
  const oauth = process.argv[2] === "oauth", secret = "sk-ant-fixture-not-a-real-key-0123456789";
  for (const r of requests) {
    if (oauth) { assert.equal(r.key, undefined); assert.equal(r.authorization, "Bearer " + secret); assert(r.beta.split(",").includes("oauth-2025-04-20")); }
    else { assert.equal(r.key, secret); assert.equal(r.authorization, null); }
    assert(!r.tools.includes("WebFetch") && !r.tools.includes("WebSearch")); }' "$STAND_IN/requests.jsonl" "${HARNESS_TEST_CREDENTIAL:-api-key}"
test ! -e /tmp/claude-hook-ran
test ! -e /tmp/claude-mcp-ran
if sudo iptables -w -S HARNESS_CLAUDE 2>/dev/null; then echo "Network chain left behind" >&2; exit 1; fi
echo "Claude stand-in run verified"
