# DragonFox Drive for Android

Open this directory in Android Studio, or install JDK 17, Android SDK Platform 35 and Build Tools 34.0.0, set `ANDROID_HOME`, and run:

```sh
./gradlew testDebugUnitTest assemblePreview
```

The installable APK is at `app/build/outputs/apk/preview/app-preview.apk`. To run device tests, connect an Android 11+ device or emulator and run `./gradlew connectedDebugAndroidTest`.

Set `DRAGONFOX_TEST_BINARY` to the absolute path of a compiled DragonFox server to include the live-server interoperability test. To include the on-device sync and gallery tests, install the debug app, grant it All files access, and start an isolated local server with registration enabled. Run `adb reverse tcp:18080 tcp:18080`, and pass `-Pandroid.testInstrumentationRunnerArguments.syncServer=http://127.0.0.1:18080` to the device test task.

Open **My files** from the main screen to browse cloud folders. Open a folder’s **⋮** menu to choose automatic, normal or photo display. Tap a photo to zoom and expand its camera details.

## Publishing APKs

- **Preview** — increase `versionCode` and update `versionName` or `preview` in [version.properties](version.properties) on `master`. After the tests pass, the Android workflow publishes an `android-vX.Y.Z-preview.N` prerelease with an APK and its SHA-256 checksum. The preview application ID is `dev.dragonfox.drive.preview`. Each CI build uses a temporary Android test key, so moving between previews may require uninstalling the old app and configuring sync again.
- **Project release** — push the usual project tag (for example, `v0.3.2`). CI tests and signs the Android app from the tagged commit, then publishes `DragonFox-Drive-v0.3.2.apk` alongside the server archives. The project release waits for both builds and includes the APK in its shared `SHA256SUMS`.
- **Android-only release** — push an `android-vX.Y.Z` tag matching the app’s `versionName` to publish a standalone signed APK.

Both production paths use the application ID `dev.dragonfox.drive` and the same four repository secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The installed app version comes from [version.properties](version.properties). Increase `versionCode` when shipping an updated client and keep the same signing key.

To verify a downloaded APK against the release manifest on Linux, run `sha256sum --ignore-missing -c SHA256SUMS` in the directory containing the APK and the manifest.
