#!/usr/bin/env bash
# Publishes a Corpus pre-release on GitHub with the signed APK.
# Usage: scripts/publish.sh <version> <notes-file>      (build the APK and push the tag first)
# Same approach as FitLedger's release script: when gh is not logged in, the GitHub token
# comes from an open VS Code window's git credential socket and is never printed or stored.
set -euo pipefail
VERSION=${1:?usage: publish.sh <version> <notes-file>}
NOTES=${2:?usage: publish.sh <version> <notes-file>}
REPO=nkuehnle/Corpus
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILT=$ROOT/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk

[ -f "$NOTES" ] || { echo "no notes file: $NOTES"; exit 1; }
[ -f "$BUILT" ] || { echo "no release APK: build it first"; exit 1; }
FOUND=$(~/Android/Sdk/build-tools/*/aapt2 dump badging "$BUILT" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -1)
[ "$FOUND" = "$VERSION" ] || { echo "the APK is version $FOUND, not $VERSION: rebuild it"; exit 1; }
~/Android/Sdk/build-tools/*/apksigner verify "$BUILT" >/dev/null || { echo "the APK is not signed"; exit 1; }
git -C "$ROOT" ls-remote --exit-code --tags origin "v$VERSION" >/dev/null || { echo "tag v$VERSION isn't on origin: push it first"; exit 1; }

DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT
cp "$BUILT" "$DIR/corpus-$VERSION.apk"

if gh auth status >/dev/null 2>&1; then
  TOKEN=""
else
  # VS Code answers git credential requests over its askpass socket.
  CODE=/snap/code/current/usr/share/code
  export GIT_ASKPASS=$CODE/resources/app/extensions/git/dist/askpass.sh
  export VSCODE_GIT_ASKPASS_NODE=$CODE/code
  export VSCODE_GIT_ASKPASS_MAIN=$CODE/resources/app/extensions/git/dist/askpass-main.js
  export VSCODE_GIT_ASKPASS_EXTRA_ARGS=
  TOKEN=""
  for sock in /run/user/1000/vscode-git-*.sock; do
    [ -S "$sock" ] || continue
    TOKEN=$(VSCODE_GIT_IPC_HANDLE=$sock timeout 10 bash -c 'printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null' | sed -n 's/^password=//p' || true)
    [ -n "$TOKEN" ] && break
  done
  [ -n "$TOKEN" ] || { echo "no token: open a VS Code window, or run gh auth login --web"; exit 1; }
fi

GH_TOKEN=$TOKEN gh release create "v$VERSION" --repo "$REPO" --verify-tag --prerelease \
  --title "Corpus $VERSION" --notes-file "$NOTES" "$DIR/corpus-$VERSION.apk" >/dev/null
unset TOKEN

curl -s "https://api.github.com/repos/$REPO/releases/tags/v$VERSION" | VERSION=$VERSION python3 -c "$(cat <<'PY'
import json, os, sys
r = json.load(sys.stdin)
want = ["corpus-" + os.environ["VERSION"] + ".apk"]
assets = {a["name"]: a["size"] for a in r.get("assets", [])}
missing = [n for n in want if n not in assets]
if missing:
    sys.exit("release is missing " + ", ".join(missing) + ": " + str(assets))
print("released:", r.get("html_url"), assets)
PY
)"
