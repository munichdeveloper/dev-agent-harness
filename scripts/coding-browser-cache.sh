#!/usr/bin/env bash
# Expose caller-installed Playwright browsers to the worker at its default location, read-only.
set -euo pipefail
SOURCE="$(node "$GITHUB_ACTION_PATH/dist/coding-cli.js" browser-cache)"
ACCOUNT="${HARNESS_ACCOUNT:-codex-worker}"
[[ "$ACCOUNT" == codex-worker || "$ACCOUNT" == claude-worker ]]
MOUNT="/home/$ACCOUNT/.cache/ms-playwright"
sudo install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 755 "/home/$ACCOUNT/.cache"
sudo install -d -o root -g root -m 755 "$MOUNT"
# A read-only bind mount grants no file permission and cannot be written through, whatever the modes are.
sudo mount --bind -- "$SOURCE" "$MOUNT"
sudo mount -o remount,bind,ro,nosuid,nodev "$MOUNT"
