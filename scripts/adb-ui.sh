# Helpers for driving the app on the `corpus` test emulator. Source this file.
#   ~/Android/Sdk/emulator/emulator -avd corpus -port 5556 -no-window -no-audio -no-snapshot &
# The WebView's contents are invisible to uiautomator, so the web UI is driven by screen
# coordinates (take a screenshot first) and native dialogs by their text.
A="$HOME/Android/Sdk/platform-tools/adb -s emulator-5556"
SHOTS=${SHOTS:-/tmp/corpus-shots}
mkdir -p "$SHOTS"
texts() { $A shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $A shell cat /sdcard/ui.xml | grep -o '\(text\|content-desc\)="[^"]\{1,80\}"[^>]*bounds="[^"]*"' | sed 's/" .*bounds=/" /'; }
tap_text() {
  local line; line=$(texts | grep -F "\"$1" | head -1)
  [ -z "$line" ] && { echo "no element: $1"; return 1; }
  $A shell input tap $(echo "$line" | sed -E 's/.*\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\].*/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
}
shot() { $A exec-out screencap -p > "$SHOTS/$1.png"; }
