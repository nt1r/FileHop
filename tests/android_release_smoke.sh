#!/usr/bin/env bash
# Exercise release signing with a disposable synthetic key on the hosted Android runner.
set -euo pipefail
: "${RUNNER_TEMP:?Requires the isolated GitHub runner}"
: "${ANDROID_HOME:?Requires the official Android SDK}"
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
temp=$(mktemp -d "$RUNNER_TEMP/filehop-signing-test.XXXXXXXX")
trap '[[ "$temp" == "$RUNNER_TEMP/filehop-signing-test."* && -d "$temp" && ! -L "$temp" ]] && rm -rf -- "$temp"' EXIT
umask 077
export FILEHOP_KEYSTORE="$temp/test.jks"
export FILEHOP_STORE_PASSWORD="synthetic-test-password"
export FILEHOP_KEY_PASSWORD="$FILEHOP_STORE_PASSWORD"
export FILEHOP_KEY_ALIAS="synthetic"
keytool -genkeypair -keystore "$FILEHOP_KEYSTORE" -alias "$FILEHOP_KEY_ALIAS" \
  -storepass:env FILEHOP_STORE_PASSWORD -keypass:env FILEHOP_KEY_PASSWORD \
  -keyalg RSA -keysize 2048 -validity 2 -dname 'CN=Synthetic FileHop Test' -noprompt
(cd "$root/android" && ./gradlew --no-daemon :app:lintRelease :app:assembleRelease -PfilehopVersionCode=2)
apk="$root/android/app/build/outputs/apk/release/app-release.apk"
"$ANDROID_HOME/build-tools/37.0.0/apksigner" verify --verbose --print-certs "$apk" > "$temp/signature.txt"
expected=$(keytool -exportcert -keystore "$FILEHOP_KEYSTORE" -alias "$FILEHOP_KEY_ALIAS" \
  -storepass:env FILEHOP_STORE_PASSWORD | sha256sum | awk '{print $1}')
# Keep the release workflow's certificate check exercised with a real synthetic APK.
actual=$(awk '/^(V[0-9.]+ Signer:|Signer #[0-9]+|Signer \(.*\)) certificate SHA-256 digest: / {print $NF}' \
  "$temp/signature.txt" | sort -u)
if [[ "$actual" != "$expected" ]]; then
  echo 'Synthetic APK certificate identity check failed.' >&2
  grep 'certificate SHA-256 digest:' "$temp/signature.txt" >&2 || true
  exit 1
fi
"$ANDROID_HOME/build-tools/37.0.0/aapt" dump badging "$apk" > "$temp/badging.txt"
grep -F "package: name='top.hammerbilly.filehop' versionCode='2'" "$temp/badging.txt" >/dev/null
grep -F "launchable-activity: name='top.hammerbilly.filehop.MainActivity'" "$temp/badging.txt" >/dev/null
grep -E "^application: .*icon='[^']+'" "$temp/badging.txt" >/dev/null
! grep -q '^application-debuggable' "$temp/badging.txt"
# Keystores are build inputs only, never APK assets.
unzip -Z1 "$apk" > "$temp/apk-files.txt"
! grep -E '\.(jks|keystore)$' "$temp/apk-files.txt"
echo 'Synthetic release signing, certificate fingerprint and package identity passed; not a device update test.'
