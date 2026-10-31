# Building the Android release

This is a native Android application (`ir.arioshub.app`), using Android's
`BiometricPrompt` and Android Keystore. It has no Google Play services or
third-party Android library dependency. Minimum Android version: 9 (API28).

The build runs on Linux with Node24, Java21 runtime, Python3 and curl. A full
JDK and Gradle are unnecessary. Tools are pinned by SHA256 and downloaded from
the official Android repository and Maven Central:

```sh
node scripts/setup-android-toolchain.mjs /secure/android-toolchain
node scripts/build-android.mjs --init-signing /secure/arios-android-signing
```

Run `ARIOS_ANDROID_ECJ_JAR=/secure/android-toolchain/downloads/ecj-3.39.0.jar node scripts/test-android-policy.mjs` to execute the native URL and filename security tests on the JVM.

Run `--init-signing` only for the first release. Preserve the generated private
directory independently. Future updates **must** use the same keystore and
alias. Never commit the keystore, password file or a signing recovery ZIP, and
never place them in the site's public downloads.

## Recovering the existing release signing key

Do not create a new signing key for updates to the published app. The repository
preserves `recovery/signing.arios`, an authenticated AES-GCM encrypted archive,
with public integrity metadata in `recovery/signing.json`. The private signing
key and its password are **not** committed. Recovery uses the same private
weekly-backup recovery key downloaded by the manager from account settings.
Keep that backup key independently; the ciphertext alone cannot recover signing.

```sh
node scripts/recover-android-signing.mjs \
  --key /secure/arios-backup-recovery-key.json \
  --out /secure/arios-signing-recovered
```

The output directory must be new and outside the checkout. The utility runs
offline, verifies authentication, key identity, ZIP format, size and checksum,
then writes a private archive with mode `0600` in a mode `0700` directory.
Extract it privately and use the recovered keystore/password paths for builds.
Never publish the recovered archive or the weekly-backup recovery key.

```sh
ARIOS_ANDROID_SDK_ROOT=/secure/android-toolchain/sdk \
ARIOS_ANDROID_ECJ_JAR=/secure/android-toolchain/downloads/ecj-3.39.0.jar \
ARIOS_ANDROID_KEYSTORE=/secure/arios-android-signing/arios-release.p12 \
ARIOS_ANDROID_KEYSTORE_PASS_FILE=/secure/arios-android-signing/keystore-password.txt \
ARIOS_ANDROID_OUTPUT=/secure/android-release \
node scripts/build-android.mjs
```

Only private file paths are passed to the signer; password values do not appear
in arguments, logs or the APK. The script compiles resources and Java sources,
builds DEX, aligns the APK and signs using Android signature schemes v2 and v3.
It then verifies the signatures, alignment, package ID and SDK versions before
writing the following files:

- `arios-android.apk`: the installable release, safe to publish.
- `arios-android.apk.sha256`: download-integrity checksum, safe to publish.
- `arios-android-release.json`: version, source-tree checksum and certificate
  fingerprint, safe to publish.
- `apk-verification.txt`: local verification evidence.

Compilation uses the official build-tools `core-lambda-stubs.jar` together
with the Android platform API. D8 desugars Java lambdas; these compile-time
stubs are not bundled in the APK.

Increase `versionCode` and `versionName` in `AndroidManifest.xml` for each
published update. The source-tree checksum covers every manifest, Java source
and resource input; it does not include signing secrets.

The installer is an APK for direct installation. It is separate from the PWA
browser shortcut, and has not been published to an app store. Android may ask
the user to allow installation from the browser for the first direct install.
