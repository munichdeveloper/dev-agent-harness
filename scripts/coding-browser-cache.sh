#!/usr/bin/env bash
# Expose caller-installed Playwright browsers to the worker at its default location, read-only.
set -euo pipefail
SOURCE="$(node "$GITHUB_ACTION_PATH/dist/coding-cli.js" browser-cache)"
MOUNT=/home/codex-worker/.cache/ms-playwright
sudo install -d -o codex-worker -g codex-worker -m 755 /home/codex-worker/.cache
sudo install -d -o root -g root -m 755 "$MOUNT"
# A read-only bind mount grants no file permission and cannot be written through, whatever the modes are.
sudo mount --bind -- "$SOURCE" "$MOUNT"
sudo mount -o remount,bind,ro,nosuid,nodev "$MOUNT"
