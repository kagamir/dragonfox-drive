# DragonFox Drive for Android

Open this directory in Android Studio, or install JDK 17, Android SDK Platform 35 and Build Tools 34.0.0, set `ANDROID_HOME`, and run:

```sh
./gradlew testDebugUnitTest assemblePreview
```

The installable APK is at `app/build/outputs/apk/preview/app-preview.apk`. To run device tests, connect an Android 11+ device or emulator and run `./gradlew connectedDebugAndroidTest`.

Set `DRAGONFOX_TEST_BINARY` to the absolute path of a compiled DragonFox server to include the live-server interoperability test. To include the on-device sync and gallery tests, install the debug app, grant it All files access, and start an isolated local server with registration enabled. Run `adb reverse tcp:18080 tcp:18080`, and pass `-Pandroid.testInstrumentationRunnerArguments.syncServer=http://127.0.0.1:18080` to the device test task.

In **Home**, open the destination folder and tap **+** to create a folder or text file, upload files, or upload an entire directory. Android’s system picker lets you upload without configuring automatic sync. Directory uploads preserve nested folders, including empty ones. Uploading again merges matching folders, skips identical files and gives different content with the same name a numbered suffix. The transfer panel shows progress and lets you cancel or retry.

Use an item’s **⋮** menu to rename, move or delete it. Long-press an item to select several files and folders, then move or delete them together. Deleting a folder also deletes its contents. Files can be downloaded or shared with a link. For text files, open the editor to change and save their content. Update the server along with the app to enable conflict checks when another device changes the same file or directory tree.

The folder menu also lets you choose automatic, normal or photo display. Tap a photo to zoom and expand its camera details.

Use **Sync** to choose the backup source and destination, enable automatic uploads, and see current tasks. Tap an album cover to browse its photos and videos, or use its checkmark to select it. Albums are ordered by the creation time of their newest media item. The four cover tiles match the first four items in the album, read from left to right. The client uses file creation time where available. If the filesystem cannot distinguish it from modification time, the client uses the date Android first indexed the media, then falls back to modification time for unindexed files. Equal timestamps are ordered by path. Open an album to see its full directory path. The storage root counts as level **1**. The scanner stops at the configured depth (default **5**) for album discovery and uploads, including scheduled scans. Each album shows media stored directly in that folder. Level **5** albums also include deeper media within the scan limit. Existing recursive backup selections keep their saved scope. With a limit below **5**, it displays only the levels actually scanned.

In **All files**, tap a folder name to browse, tick its checkbox to back it up, or tap a file to preview it. The parent entry stays at the top, including when the folder is empty. You can browse the actual file tree through the configured scan depth. Images, videos, audio, PDFs and common text files open in the app. Other files show their type and size.

An active sync, manual upload or download continues when you switch apps or lock the screen. On Android 13 and later, tap **Show transfer notifications** to see progress in the notification shade. Disabling automatic sync stops its current scan and future scheduled checks. Signing out stops that account’s transfers.

While the app is visible, automatic sync uses the interval in **Account**. In the background, Android schedules network-connected checks at the longer of that interval and 15 minutes. Doze, battery restrictions and system quotas can delay a check. Scheduled sync can restore the signed-in session after a process restart or reboot. Manual transfers use the running service and can be started again if Android stops the app. After a force-stop, open the app to resume automatic scheduling.

Open **Account** to change the theme, scan interval or maximum folder depth, check the app version, or sign out.

## Publishing APKs

The version shown under **Account → About** and reported to the server comes from the installed APK. CI derives its `versionName` from the GitHub release tag, including prerelease and build suffixes, and checks the packaged manifest before publishing.

| Release channel | Example GitHub tag | App and reported version |
| --- | --- | --- |
| Project release | `v0.4.2` | `0.4.2` |
| Android-only release | `android-v0.4.2` | `0.4.2` |
| Android preview | `android-v0.4.2-preview.8` | `0.4.2-preview.8` |

- **Preview** — on `master`, CI uses the highest stable project version tagged in the commit's history and the `preview` counter in [version.properties](version.properties). Increase the counter when publishing another preview for that version. The preview application ID is `dev.dragonfox.drive.preview`. CI uses a temporary signing key, so moving between previews may require uninstalling the old app and configuring sync again.
- **Project release** — push the usual project tag. CI publishes the signed APK alongside the server archives with a shared `SHA256SUMS`.
- **Android-only release** — push an `android-vX.Y.Z` tag to publish a standalone signed APK. Its release page includes the APK and its SHA-256 checksum.

Both production channels use `dev.dragonfox.drive` and the same four repository secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Increase the numeric `versionCode` in [version.properties](version.properties) when shipping an updated client. The file's `versionName` is the fallback for local builds and for previews before the first project tag. For a local build matching a release, pass the version explicitly, for example `./gradlew -PdragonfoxVersionName=0.4.2 assembleRelease`.

To verify a downloaded APK against the release manifest on Linux, run `sha256sum --ignore-missing -c SHA256SUMS` in the directory containing the APK and the manifest.
