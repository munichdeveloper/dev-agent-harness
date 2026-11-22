#!/usr/bin/env bash
# After the agent: the sandbox had no network, so a worker that added or changed an npm dependency could not update
# package-lock.json. When the root package.json differs from the snapshot taken before the agent, resolve the lockfile
# here: as the runner account, outside the checkout, on a copy of the two files, with scripts off, the public registry
# and no npm configuration of the checkout or the account (no credentials). The result replaces the checkout's
# lockfile and is collected like any other change; the independent validation still installs it with npm ci.
# Failing to resolve never fails the run: the lockfile stays as the worker left it and validation reports it.
set -euo pipefail
ACCOUNT="${HARNESS_ACCOUNT:?}"; TARGET="${HARNESS_WORKSPACE:?}"; BASE="${RUN_DIRECTORY:?}/npm-base"
[[ "$ACCOUNT" == codex-worker || "$ACCOUNT" == claude-worker ]]
[[ -f "$BASE/package.json" ]] || exit 0
sudo pkill -KILL -u "$ACCOUNT" || true
manifest="$TARGET/package.json"; lock="$TARGET/package-lock.json"
[[ -f "$manifest" && ! -L "$manifest" && "$(wc -c < "$manifest")" -le 1000000 ]] || exit 0
if cmp -s -- "$manifest" "$BASE/package.json"; then exit 0; fi
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/npm-lock-XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/project" "$work/home"
: > "$work/user.npmrc"; : > "$work/global.npmrc"
cp -- "$manifest" "$work/project/package.json"
if [[ -f "$lock" && ! -L "$lock" && "$(wc -c < "$lock")" -le 20000000 ]]; then cp -- "$lock" "$work/project/package-lock.json"
else cp -- "$BASE/package-lock.json" "$work/project/package-lock.json"; fi
if ! jq -e 'type == "object" and (has("workspaces") | not)' "$work/project/package.json" >/dev/null 2>&1; then
  echo "package.json changed but is no plain npm manifest; package-lock.json left as is"; exit 0
fi
# Only the runner's proxy settings pass on (self-hosted runners may need them); no token, no other variable.
pass=(PATH="$PATH" HOME="$work/home")
for name in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy NODE_EXTRA_CA_CERTS; do
  if [[ -n "${!name:-}" ]]; then pass+=("$name=${!name}"); fi
done
if ! (cd "$work/project" && env -i "${pass[@]}" timeout 300 npm install --package-lock-only --ignore-scripts \
    --no-audit --no-fund --userconfig="$work/user.npmrc" --globalconfig="$work/global.npmrc" --registry=https://registry.npmjs.org/); then
  echo "::warning::package.json changed, but package-lock.json could not be resolved; it is left as the worker left it"
  exit 0
fi
if [[ -f "$lock" && ! -L "$lock" ]] && cmp -s -- "$work/project/package-lock.json" "$lock"; then exit 0; fi
sudo rm -f -- "$lock"
sudo install -o "$ACCOUNT" -g "$ACCOUNT" -m 0644 -- "$work/project/package-lock.json" "$lock"
echo "Resolved package-lock.json for the changed package.json"
