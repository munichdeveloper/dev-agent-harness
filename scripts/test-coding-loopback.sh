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
# A Playwright project whose webServer starts a local HTTP server; browsers come from the shared read-only cache.
BROWSER_TEST_DIR="$TARGET/browser-test"; export BROWSER_TEST_DIR
mkdir -p "$BROWSER_TEST_DIR"
cp scripts/fixtures/browser-test/* "$BROWSER_TEST_DIR/"
npm install --prefix "$BROWSER_TEST_DIR" --no-audit --no-fund "@playwright/test@${PLAYWRIGHT_VERSION:-1.65.0}"
if [[ -n "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" ]]; then cp -a "$PLAYWRIGHT_BROWSERS_PATH/." "$HARNESS_BROWSER_CACHE/"
else PLAYWRIGHT_BROWSERS_PATH="$HARNESS_BROWSER_CACHE" "$BROWSER_TEST_DIR/node_modules/.bin/playwright" install --only-shell chromium; fi
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
# A real codex exec against a stand-in API: Codex reaches it, the command cannot leave its loopback, survives
# refused registry lookups and passes a Playwright test against a local server in the bundled headless Chromium.
node scripts/test-loopback-exec.mjs
# Control: without the command environment, Codex aborts the command at the first refused registry lookup.
CONTROL_HOME="$RUNNER_TEMP/coding-loopback-control"
sudo install -d -o codex-worker -g codex-worker "$CONTROL_HOME"
sed '/^\[shell_environment_policy.set\]/,/^$/d' /home/codex-worker/.codex/config.toml | sudo -u codex-worker tee "$CONTROL_HOME/config.toml" >/dev/null
refused grep -q BASH_ENV "$CONTROL_HOME/config.toml"
CODEX_HOME="$CONTROL_HOME" EXPECTED_VERDICT='a blocked network request aborted the command' node scripts/test-loopback-exec.mjs
