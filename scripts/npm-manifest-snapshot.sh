#!/usr/bin/env bash
# Before the worker gets the checkout: remember the root npm manifest and lockfile, so the step after the agent can
# tell whether the worker changed its dependencies. Only a plain npm project (regular files, no workspaces) counts.
set -euo pipefail
TARGET="${HARNESS_WORKSPACE:?}"; BASE="${RUN_DIRECTORY:?}/npm-base"
for file in package.json package-lock.json; do
  [[ -f "$TARGET/$file" && ! -L "$TARGET/$file" ]] || exit 0
done
[[ "$(wc -c < "$TARGET/package.json")" -le 1000000 ]] || exit 0
jq -e 'type == "object" and (has("workspaces") | not)' "$TARGET/package.json" >/dev/null 2>&1 || exit 0
mkdir -p "$BASE"
cp -- "$TARGET/package.json" "$TARGET/package-lock.json" "$BASE/"
