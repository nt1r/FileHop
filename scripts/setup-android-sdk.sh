#!/usr/bin/env bash
# Official SDK setup for the isolated GitHub-hosted x86-64 build job, not the VPS.
set -euo pipefail
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo 'Android SDK builds require the Linux x86-64 hosted runner.' >&2
  exit 1
}
: "${RUNNER_TEMP:?Run in the GitHub-hosted build job}"
: "${GITHUB_ENV:?Missing GitHub environment file}"
export ANDROID_HOME="$RUNNER_TEMP/filehop-android-sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
archive="$RUNNER_TEMP/filehop-commandlinetools.zip"
curl --fail --location --max-time 180 --output "$archive" \
  https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip
printf '%s  %s\n' '0877a1d048fe4a24efe2eff536ca4223f7adeb58648bb81909d33c446918cfa8' "$archive" | sha256sum --check
unzip -q "$archive" -d "$ANDROID_HOME/cmdline-tools"
mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
manager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
printf 'y\n%.0s' {1..100} | "$manager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null
"$manager" --sdk_root="$ANDROID_HOME" 'platforms;android-37.2' 'build-tools;37.0.0'
printf 'ANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\n' "$ANDROID_HOME" "$ANDROID_HOME" >> "$GITHUB_ENV"
