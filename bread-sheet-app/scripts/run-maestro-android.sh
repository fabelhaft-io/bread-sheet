#!/usr/bin/env bash
# Build the native debug client, boot a reproducible local AVD, and run the
# native camera flows. This is intentionally idempotent so reviewers can run
# the same command on every ticket.
set -euo pipefail

# Keep the native smoke test self-provisioning. A fresh developer machine (and a
# clean CI runner) should only need bash, curl, unzip and Java; SDK/AVD/Maestro
# setup must not be a per-run checklist.
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
AVD_NAME="${ANDROID_AVD_NAME:-bread-sheet-api-35}"
SYSTEM_IMAGE="system-images;android-35;google_apis;x86_64"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
EMULATOR="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"

provision_android_sdk() {
  if [[ -x "$SDKMANAGER" && -x "$AVDMANAGER" && -x "$EMULATOR" && -x "$ADB" ]]; then
    return
  fi
  command -v curl >/dev/null || { echo 'curl is required to provision Android SDK' >&2; exit 1; }
  command -v unzip >/dev/null || { echo 'unzip is required to provision Android SDK' >&2; exit 1; }
  command -v java >/dev/null || { echo 'Java 17+ is required by Android SDK tools' >&2; exit 1; }

  local archive="/tmp/commandlinetools-linux-11076708_latest.zip"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  if [[ ! -f "$archive" ]]; then
    curl --fail --location --retry 3 --output "$archive" \
      'https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip'
  fi
  rm -rf "$ANDROID_HOME/cmdline-tools/latest.tmp"
  mkdir -p "$ANDROID_HOME/cmdline-tools/latest.tmp"
  unzip -q -o "$archive" -d "$ANDROID_HOME/cmdline-tools/latest.tmp"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$ANDROID_HOME/cmdline-tools/latest.tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
}

provision_android_sdk
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

if ! command -v maestro >/dev/null; then
  command -v curl >/dev/null || { echo 'curl is required to provision Maestro' >&2; exit 1; }
  curl -Ls https://get.maestro.mobile.dev | bash
  export PATH="$HOME/.maestro/bin:$PATH"
fi

for command in "$SDKMANAGER" "$AVDMANAGER" "$EMULATOR" "$ADB"; do
  [[ -x "$command" ]] || { echo "Missing Android SDK tool: $command" >&2; exit 1; }
done
command -v maestro >/dev/null || { echo 'Maestro installation failed' >&2; exit 1; }

# Accept licenses non-interactively; sdkmanager is idempotent when packages
# are already installed.
yes | "$SDKMANAGER" --licenses >/dev/null || true

"$SDKMANAGER" "platform-tools" "emulator" "platforms;android-35" "$SYSTEM_IMAGE" >/dev/null
if ! "$AVDMANAGER" list avd 2>/dev/null | grep -q "^Name: $AVD_NAME$"; then
  yes | "$AVDMANAGER" create avd --force --name "$AVD_NAME" --package "$SYSTEM_IMAGE" --device "pixel_6" >/dev/null
fi

if ! "$ADB" get-state >/dev/null 2>&1; then
  "$EMULATOR" -avd "$AVD_NAME" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect >/tmp/bread-sheet-emulator.log 2>&1 &
fi
"$ADB" wait-for-device >/dev/null
until [[ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do sleep 2; done

# Headless emulators cannot receive camera frames from Maestro. The debug-only
# fixture drives the same expo-camera barcode callback deterministically. Users
# can override it with any valid EAN-13 value.
export EXPO_PUBLIC_MAESTRO_BARCODE="${EXPO_PUBLIC_MAESTRO_BARCODE:-4006381333931}"

# Expo's native build installs the debug APK on the running AVD.
npx expo run:android --variant debug --no-bundler --device "$AVD_NAME"
maestro test e2e/maestro/barcode-scan.yaml

exit 0
