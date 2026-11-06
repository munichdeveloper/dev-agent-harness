#!/usr/bin/env bash
set -euo pipefail
export GITHUB_ACTION_PATH="$PWD"
export HARNESS_EXECUTION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export HARNESS_WORKSPACE="$RUNNER_TEMP/coding-account-target"
export RUN_DIRECTORY="$RUNNER_TEMP/harness-$HARNESS_EXECUTION_ID"
mkdir -p "$HARNESS_WORKSPACE"
git -C "$HARNESS_WORKSPACE" init
git -C "$HARNESS_WORKSPACE" -c user.name=CI -c user.email=ci@example.invalid commit --allow-empty -m base
BASE_SHA="$(git -C "$HARNESS_WORKSPACE" rev-parse HEAD)"; export BASE_SHA
HARNESS_REQUEST="$(node --input-type=module -e '
  console.log(JSON.stringify({contractVersion:"3.0", executionId:process.env.HARNESS_EXECUTION_ID, worker:"codex",
    task:{id:"fixture:1",version:"b".repeat(64),description:"Test collection",acceptanceCriteria:["Collected"],contextReferences:[]},
    allowedActions:["edit_workspace","run_commands"],baseSha:process.env.BASE_SHA, model:"gpt-6.1-sol",effort:"high",
    limits:{timeoutMinutes:1,maxFiles:100,maxPatchBytes:5000000}}));')"; export HARNESS_REQUEST
node dist/coding-cli.js prepare
sudo adduser --system --home /home/codex-worker --shell /bin/bash --group codex-worker
sudo chmod o+x /home/runner /home/runner/work
sudo chmod o+x /home/codex-worker
sudo chown -R codex-worker:codex-worker "$HARNESS_WORKSPACE"
chmod o+rx "$RUN_DIRECTORY"
sudo install -d -o codex-worker -g codex-worker "$RUN_DIRECTORY/output"
printf '{"status":"success","summary":"Fixture collected"}\n' | sudo -u codex-worker tee "$RUN_DIRECTORY/output/message.json" >/dev/null
sudo -u codex-worker bash -c 'echo fixture > "$1/new.txt"' _ "$HARNESS_WORKSPACE"
bash scripts/collect-coding.sh
node --input-type=module -e '
  import fs from "node:fs"; import assert from "node:assert/strict";
  const value=JSON.parse(fs.readFileSync(process.env.RUN_DIRECTORY+"/artifact.json"));
  assert.equal(value.result.status,"success"); assert.equal(value.changes[0].path,"new.txt");
  assert.equal(Buffer.from(value.changes[0].content,"base64").toString(),"fixture\n");'
