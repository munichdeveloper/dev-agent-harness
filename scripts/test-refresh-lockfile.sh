#!/usr/bin/env bash
# CI: the lockfile step after the agent resolves package-lock.json for a changed package.json, replaces a planted
# symlink, ignores the checkout's .npmrc and leaves an unchanged manifest alone. Needs sudo and registry access.
set -euo pipefail
export GITHUB_ACTION_PATH="$PWD" HARNESS_ACCOUNT=codex-worker
export HARNESS_WORKSPACE="$RUNNER_TEMP/refresh-lock-target" RUN_DIRECTORY="$RUNNER_TEMP/refresh-lock-run"
mkdir -p "$HARNESS_WORKSPACE" "$RUN_DIRECTORY"
sudo chmod o+x /home/runner /home/runner/work 2>/dev/null || true
chmod o+x "$RUNNER_TEMP"
id codex-worker >/dev/null 2>&1 || sudo adduser --system --home /home/codex-worker --shell /bin/bash --group codex-worker
printf '{"name":"fixture","version":"1.0.0","private":true}\n' > "$HARNESS_WORKSPACE/package.json"
(cd "$HARNESS_WORKSPACE" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)
bash scripts/npm-manifest-snapshot.sh
test -f "$RUN_DIRECTORY/npm-base/package.json"
sudo chown -R codex-worker:codex-worker "$HARNESS_WORKSPACE"

# Unchanged manifest: nothing happens.
before="$(sha256sum "$HARNESS_WORKSPACE/package-lock.json")"
bash scripts/refresh-lockfile.sh
test "$(sha256sum "$HARNESS_WORKSPACE/package-lock.json")" = "$before"

# The worker adds a dependency, plants a symlinked lockfile and an .npmrc pointing elsewhere.
sudo -u codex-worker bash -c 'cd "$1" && printf "{\"name\":\"fixture\",\"version\":\"1.0.0\",\"private\":true,\"dependencies\":{\"is-number\":\"7.0.0\"}}\n" > package.json &&
  rm package-lock.json && ln -s /etc/hostname package-lock.json && printf "registry=http://127.0.0.1:9/\n" > .npmrc' _ "$HARNESS_WORKSPACE"
bash scripts/refresh-lockfile.sh
lock="$HARNESS_WORKSPACE/package-lock.json"
test -f "$lock" && test ! -L "$lock"
test "$(stat -c %U "$lock")" = codex-worker
jq -e '.packages["node_modules/is-number"].version == "7.0.0" and (.packages["node_modules/is-number"].resolved | startswith("https://registry.npmjs.org/"))' "$lock" >/dev/null
(cd "$HARNESS_WORKSPACE" && sudo -u codex-worker npm ci --dry-run --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ >/dev/null)
echo "Lockfile refresh fixture passed"
