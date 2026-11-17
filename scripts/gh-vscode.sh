#!/usr/bin/env bash
# Runs gh with GitHub credentials: gh's own login if it has one, otherwise the token an open
# VS Code window serves over its git credential socket. The token is never printed or stored.
set -euo pipefail
if gh auth status >/dev/null 2>&1; then exec gh "$@"; fi
CODE=/snap/code/current/usr/share/code
export GIT_ASKPASS=$CODE/resources/app/extensions/git/dist/askpass.sh
export VSCODE_GIT_ASKPASS_NODE=$CODE/code
export VSCODE_GIT_ASKPASS_MAIN=$CODE/resources/app/extensions/git/dist/askpass-main.js
export VSCODE_GIT_ASKPASS_EXTRA_ARGS=
TOKEN=""
for sock in /run/user/$(id -u)/vscode-git-*.sock; do
  [ -S "$sock" ] || continue
  TOKEN=$(VSCODE_GIT_IPC_HANDLE=$sock timeout 10 bash -c 'printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null' | sed -n 's/^password=//p' || true)
  [ -n "$TOKEN" ] && break
done
[ -n "$TOKEN" ] || { echo "no token: open a VS Code window, or run gh auth login --web" >&2; exit 1; }
GH_TOKEN=$TOKEN exec gh "$@"
