# DragonFox Drive for Android

Open this directory in Android Studio, or install JDK 17, Android SDK Platform 35 and Build Tools 34.0.0, set `ANDROID_HOME`, and run:

```sh
./gradlew testDebugUnitTest assemblePreview
```

The installable APK is at `app/build/outputs/apk/preview/app-preview.apk`. To run device tests, connect an Android 11+ device or emulator and run `./gradlew connectedDebugAndroidTest`.

Set `DRAGONFOX_TEST_BINARY` to the absolute path of a compiled DragonFox server to include the live-server interoperability test. To include the on-device sync and gallery tests, install the debug app, grant it All files access, and start an isolated local server with registration enabled. Run `adb reverse tcp:18080 tcp:18080`, and pass `-Pandroid.testInstrumentationRunnerArguments.syncServer=http://127.0.0.1:18080` to the device test task.

The **Home** tab opens the cloud file browser. Open a folder’s **⋮** menu to choose automatic, normal or photo display. Tap a photo to zoom and expand its camera details.

Use **Sync** to choose the backup source and destination, enable automatic uploads, and see current tasks. Tap an album cover to browse its photos and videos, or use its checkmark to select it. Albums are ordered by the creation time of their newest media item. The four cover tiles match the first four items in the album, read from left to right. The client uses file creation time where available. If the filesystem cannot distinguish it from modification time, the client uses the date Android first indexed the media, then falls back to modification time for unindexed files. Equal timestamps are ordered by path. Open an album to see its full directory path. The storage root counts as level **1**. The scanner stops at the configured depth (default **5**) for album discovery and uploads, including scheduled scans. Each album shows media stored directly in that folder. Level **5** albums also include deeper media within the scan limit. Existing recursive backup selections keep their saved scope. With a limit below **5**, it displays only the levels actually scanned.

In **All files**, tap a folder name to browse, tick its checkbox to back it up, or tap a file to preview it. The parent entry stays at the top, including when the folder is empty. You can browse the actual file tree through the configured scan depth. Images, videos, audio, PDFs and common text files open in the app. Other files show their type and size.

Open **Account** to change the theme, scan interval or maximum folder depth, check the app version, or sign out.

## Publishing APKs

- **Preview** — increase `versionCode` and update `versionName` or `preview` in [version.properties](version.properties) on `master`. After the tests pass, the Android workflow publishes an `android-vX.Y.Z-preview.N` prerelease with an APK and its SHA-256 checksum. The preview application ID is `dev.dragonfox.drive.preview`. Each CI build uses a temporary Android test key, so moving between previews may require uninstalling the old app and configuring sync again.
- **Project release** — push the usual project tag (for example, `v0.3.2`). CI tests and signs the Android app from the tagged commit, then publishes `DragonFox-Drive-v0.3.2.apk` alongside the server archives. The project release waits for both builds and includes the APK in its shared `SHA256SUMS`.
- **Android-only release** — push an `android-vX.Y.Z` tag matching the app’s `versionName` to publish a standalone signed APK.

Both production paths use the application ID `dev.dragonfox.drive` and the same four repository secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The installed app version comes from [version.properties](version.properties). Increase `versionCode` when shipping an updated client and keep the same signing key.

To verify a downloaded APK against the release manifest on Linux, run `sha256sum --ignore-missing -c SHA256SUMS` in the directory containing the APK and the manifest.
