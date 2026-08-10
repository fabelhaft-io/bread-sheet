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

java_major_version() {
  # Java 8 reports `1.8.x`, while modern Java reports `17.0.x`. Match only the
  # version token so vendor launcher output cannot be mistaken for Java's
  # version, then normalize the legacy 1.x form.
  local version
  version="$(java -version 2>&1 | sed -nE 's/^[[:space:]]*.*version "([^"]+)".*/\1/p' | head -n1)"
  if [[ "$version" =~ ^1\.([0-9]+)([.-]|$) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  elif [[ "$version" =~ ^([0-9]+)([.-]|$) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf '0\n'
  fi
}

ensure_java() {
  local java_major=0
  if command -v java >/dev/null 2>&1; then
    # `java -version` writes to stderr. This also handles vendors that report
    # versions as `17.0.x` and the old `1.8.x` format without relying on a JDK
    # manager being installed on the host.
    java_major="$(java_major_version)"
    [[ "$java_major" =~ ^[0-9]+$ ]] || java_major=0
  fi
  if (( java_major < 17 )); then
    command -v curl >/dev/null || { echo 'curl is required to provision Java 17' >&2; exit 1; }
    command -v tar >/dev/null || { echo 'tar is required to provision Java 17' >&2; exit 1; }

    local java_root="$HOME/.cache/bread-sheet/android-jdk-17"
    local java_archive="/tmp/temurin-jdk17-linux-x64.tar.gz"
    if [[ ! -x "$java_root/bin/java" ]]; then
      mkdir -p "$HOME/.cache/bread-sheet"
      if [[ ! -f "$java_archive" ]]; then
        curl --fail --location --retry 3 --output "$java_archive" \
          'https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse'
      fi
      rm -rf "$java_root.tmp"
      mkdir -p "$java_root.tmp"
      tar -xzf "$java_archive" -C "$java_root.tmp"
      mv "$java_root.tmp"/* "$java_root"
      rm -rf "$java_root.tmp"
    fi
    export JAVA_HOME="$java_root"
    export PATH="$JAVA_HOME/bin:$PATH"
    java_major="$(java_major_version)"
  fi
  (( java_major >= 17 )) || { echo 'Java 17+ is required by Android SDK tools' >&2; exit 1; }
}

provision_android_sdk() {
  if [[ -x "$SDKMANAGER" && -x "$AVDMANAGER" && -x "$EMULATOR" && -x "$ADB" ]]; then
    return
  fi
  command -v curl >/dev/null || { echo 'curl is required to provision Android SDK' >&2; exit 1; }
  command -v unzip >/dev/null || { echo 'unzip is required to provision Android SDK' >&2; exit 1; }

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

ensure_java
provision_android_sdk
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# Android's `localhost` is the emulator itself. Keep the API prerequisite
# reproducible by translating a host-local URL to the emulator's documented
# host alias. EXPO_PUBLIC_API_URL is captured by the native debug bundle at
# build time, so this must happen before `expo run:android`.
if [[ -n "${EXPO_PUBLIC_API_URL:-}" ]]; then
  if [[ "$EXPO_PUBLIC_API_URL" =~ ^(https?://)(localhost|127\.0\.0\.1)(:.*|/.*|$) ]]; then
    EXPO_PUBLIC_API_URL="${BASH_REMATCH[1]}10.0.2.2${BASH_REMATCH[3]}"
  fi
else
  EXPO_PUBLIC_API_URL="http://10.0.2.2:3000"
fi
export EXPO_PUBLIC_API_URL

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
