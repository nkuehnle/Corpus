#!/usr/bin/env bash
# Publishes a Corpus pre-release on GitHub with the signed APK and, if built, the study plan.
# Usage: scripts/publish.sh <version> <notes-file>      (build the APK and push the tag first)
# Credentials come from scripts/gh-vscode.sh (gh's login, or an open VS Code window).
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

# The study plan is attached when it has been built, so it can be downloaded on the phone.
PLAN=$ROOT/data/muscle-growth.db
ASSETS=("$DIR/corpus-$VERSION.apk")
[ -f "$PLAN" ] && cp "$PLAN" "$DIR/muscle-growth.db" && ASSETS+=("$DIR/muscle-growth.db")

"$ROOT/scripts/gh-vscode.sh" release create "v$VERSION" --repo "$REPO" --verify-tag --prerelease \
  --title "Corpus $VERSION" --notes-file "$NOTES" "${ASSETS[@]}" >/dev/null

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
