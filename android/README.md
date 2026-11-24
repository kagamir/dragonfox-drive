# DragonFox Drive for Android

Open this directory in Android Studio, or install JDK 17, Android SDK Platform 35 and Build Tools 34.0.0, set `ANDROID_HOME`, and run:

```sh
./gradlew testDebugUnitTest assemblePreview
```

The installable APK is at `app/build/outputs/apk/preview/app-preview.apk`. To run device tests, connect an Android 11+ device or emulator and run `./gradlew connectedDebugAndroidTest`.

Set `DRAGONFOX_TEST_BINARY` to the absolute path of a compiled DragonFox server to include the live-server interoperability test. To include the on-device sync test, use an isolated local server with registration enabled, run `adb reverse tcp:18080 tcp:18080`, and pass `-Pandroid.testInstrumentationRunnerArguments.syncServer=http://127.0.0.1:18080` to the device test task.

## Publishing APKs

- **Preview** — increase `versionCode` and update `versionName` or `preview` in [version.properties](version.properties) on `master`. After the tests pass, the Android workflow publishes an `android-vX.Y.Z-preview.N` prerelease with an APK and its SHA-256 checksum. The preview application ID is `dev.dragonfox.drive.preview`. Each CI build uses a temporary Android test key, so moving between previews may require uninstalling the old app and configuring sync again.
- **Production** — maintain a backed-up signing keystore and configure repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Push an `android-vX.Y.Z` tag matching `versionName`. Use a higher `versionCode` and the same key for each upgrade. The application ID is `dev.dragonfox.drive`.

Both channels publish APKs and `SHA256SUMS` as GitHub Release assets. From the download directory, run `sha256sum -c SHA256SUMS` to check the APK.
