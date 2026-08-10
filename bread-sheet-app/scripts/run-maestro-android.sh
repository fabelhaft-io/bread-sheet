#!/usr/bin/env bash
# Build the native debug client, boot a reproducible local AVD, and run the
# native camera flows. This is intentionally idempotent so reviewers can run
# the same command on every ticket.
set -euo pipefail

: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
AVD_NAME="${ANDROID_AVD_NAME:-bread-sheet-api-35}"
SYSTEM_IMAGE="system-images;android-35;google_apis;x86_64"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
[[ -x "$SDKMANAGER" ]] || SDKMANAGER="$ANDROID_HOME/tools/bin/sdkmanager"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
[[ -x "$AVDMANAGER" ]] || AVDMANAGER="$ANDROID_HOME/tools/bin/avdmanager"
EMULATOR="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"

for command in "$SDKMANAGER" "$AVDMANAGER" "$EMULATOR" "$ADB"; do
  [[ -x "$command" ]] || { echo "Missing Android SDK tool: $command" >&2; exit 1; }
done
command -v maestro >/dev/null || { echo 'Install Maestro: https://maestro.mobile.dev/getting-started/installing-maestro' >&2; exit 1; }

"$SDKMANAGER" "platform-tools" "platforms;android-35" "$SYSTEM_IMAGE" >/dev/null
if ! "$AVDMANAGER" list avd 2>/dev/null | grep -q "^Name: $AVD_NAME$"; then
  yes | "$AVDMANAGER" create avd --force --name "$AVD_NAME" --package "$SYSTEM_IMAGE" --device "pixel_6" >/dev/null
fi

if ! "$ADB" get-state >/dev/null 2>&1; then
  "$EMULATOR" -avd "$AVD_NAME" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect >/tmp/bread-sheet-emulator.log 2>&1 &
fi
"$ADB" wait-for-device >/dev/null
until [[ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do sleep 2; done

# Expo's native build installs the debug APK on the running AVD.
npx expo run:android --variant debug --no-bundler --device "$AVD_NAME"
maestro test e2e/maestro/barcode-scan.yaml
