package dev.dragonfox.drive

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.sync.FileAccess
import dev.dragonfox.drive.sync.FolderScanner
import dev.dragonfox.drive.sync.SyncConfig
import dev.dragonfox.drive.sync.SyncMode
import dev.dragonfox.drive.sync.SyncStorage
import dev.dragonfox.drive.ui.LocalPicker
import java.io.File
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LocalAlbumsTest {
    @get:Rule val screen = createComposeRule()

    @Test fun realVolumeDepthSelectsOnlyVisibleMediaAndRestoresEachAlbumScope() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue("Grant all-files access to the debug build", FileAccess.granted(context))
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val scope = "picker-" + UUID.randomUUID()
        val root = File(downloads, scope) // Volume = 1, Download = 2, fixture = 3.
        val many = File(root, "旅行").apply { check(mkdirs()) }
        val bucket = File(root, "4/5").apply { check(mkdirs()) }
        val deep = File(bucket, "6/7/8/9").apply { check(mkdirs()) }
        val beyondLimit = File(deep, "10/11").apply { check(mkdirs()) }
        val scanner = FolderScanner(context)
        val storage = SyncStorage(context, scope)
        // Direct siblings under "4" share no album because "4" contains no media.
        val sibling = File(root, "4/independent").apply { check(mkdirs()) }
        val siblingPhoto = File(sibling, "sibling.jpg")
        // A separate album shares the boundary album's display name.
        val twin = File(root, "other/5").apply { check(mkdirs()) }
        val twinPhoto = File(twin, "oldest.jpg")
        val beijing = File(many, "北京").apply { check(mkdir()) }
        val shanghai = File(many, "上海").apply { check(mkdir()) }
        val beijingPhoto = File(beijing, "beijing.jpg")
        val shanghaiPhoto = File(shanghai, "shanghai.jpg")
        val oldestFirst = listOf("z.jpg", "a.jpg", "b.jpg", "clip.mp4", "d.jpg").map { File(many, it) }
        val newestFirst = oldestFirst.asReversed()
        val directPhoto = File(bucket, "direct.jpg")
        val deepPhoto = File(deep, "deep.jpg")
        val ignoredPhoto = File(beyondLimit, "out-of-range.jpg")
        val other = File(deep, "excluded.txt")
        try {
            createMediaInOrder(context, listOf(siblingPhoto, twinPhoto, beijingPhoto, shanghaiPhoto) + oldestFirst + directPhoto + deepPhoto + ignoredPhoto)
            other.writeText("not media")

            runBlocking {
                val albums = scanner.mediaBuckets(10).filter { it.directory.toPath().startsWith(root.toPath()) }
                assertEquals(listOf(bucket, many, shanghai, beijing, twin, sibling), albums.map { it.directory })
                assertEquals(listOf(beijingPhoto), albums.single { it.directory == beijing }.page(0, 4))
                assertEquals(listOf(shanghaiPhoto), albums.single { it.directory == shanghai }.page(0, 4))
                val travel = albums.single { it.directory == many }
                assertFalse(travel.recursive)
                assertEquals(5, travel.count)
                assertEquals(newestFirst.take(4), travel.covers)
                assertEquals(newestFirst, travel.page(0, 2) + travel.page(2, 3))
                val aggregate = albums.single { it.directory == bucket }
                assertEquals(2, aggregate.count)
                assertTrue(aggregate.recursive)
                assertEquals(listOf(deepPhoto, directPhoto), aggregate.page(0, 10))
                val shallow = scanner.mediaBuckets(5).single { it.directory == bucket }
                assertFalse(shallow.recursive)
                assertEquals(1, shallow.count)
                assertEquals(listOf(directPhoto), shallow.covers)
                assertEquals(listOf(directPhoto), shallow.page(0, 10))
            }

            var plan by mutableStateOf(SyncConfig(mode = SyncMode.MEDIA, maxDepth = 10))
            var pickerOpen by mutableStateOf(true)
            screen.setContent {
                MaterialTheme {
                    if (pickerOpen) LocalPicker(
                        plan.mode, plan.localFolders, plan.recursiveFolders, plan.maxDepth, true, {}, {}
                    ) { mode, paths, recursive ->
                        storage.save(plan.copy(localFolders = paths, mode = mode, recursiveFolders = recursive))
                        pickerOpen = false
                    }
                }
            }
            fun item(tag: String) = screen.onNodeWithTag(tag, useUnmergedTree = true)
            fun awaitTag(tag: String) = screen.waitUntil(30_000) {
                screen.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
            }
            fun showAlbum(file: File) {
                awaitTag("local-albums")
                item("local-albums").performScrollToKey(file.path)
                item("local-album:" + file.path).assertIsDisplayed()
            }
            fun assertCount(file: File, count: Int) {
                val text = context.getString(R.string.df_album_count, count)
                screen.onNode(hasAnyAncestor(hasTestTag("local-album:" + file.path)) and hasText(text),
                    useUnmergedTree = true).assertIsDisplayed()
            }
            for (city in listOf(beijing, shanghai)) {
                showAlbum(city)
                item("local-select:" + city.path).assertIsOff()
            }
            showAlbum(many)
            val index = item("local-albums").fetchSemanticsNode().config[SemanticsProperties.IndexForKey]
            assertTrue("The newer two-item album precedes the older five-item album", index(bucket.path) in 0 until index(many.path))
            assertCount(many, 5)
            val covers = newestFirst.take(4).map { file ->
                item("local-cover:" + file.path).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            }
            assertTrue("Four covers use newest-first reading order",
                covers[0].center.x < covers[1].center.x && covers[2].center.x < covers[3].center.x &&
                    covers[0].center.y == covers[1].center.y && covers[2].center.y == covers[3].center.y &&
                    covers[0].center.y < covers[2].center.y)
            item("local-cover:" + oldestFirst.first().path).assertDoesNotExist()
            item("local-album:" + many.path).performClick()
            awaitTag("local-item:" + newestFirst.first().path)
            val mediaGrid = item("local-media")
            val mediaIndex = mediaGrid.fetchSemanticsNode().config[SemanticsProperties.IndexForKey]
            val positions = newestFirst.map { mediaIndex(it.path) }
            // The full-width path is item 0. Every following item must match the cover order.
            assertEquals((1..newestFirst.size).toList(), positions)
            val path = item("local-album-path").assertTextEquals(many.absolutePath).assertIsDisplayed()
            val title = screen.onNodeWithText(many.name, useUnmergedTree = true)
            assertTrue("Full folder path appears below the album name",
                path.fetchSemanticsNode().boundsInRoot.top >= title.fetchSemanticsNode().boundsInRoot.bottom - 1)
            item("local-item:" + newestFirst.first().path).performClick()
            awaitTag("local-media-detail")
            item("viewer-title").assertTextEquals(newestFirst.first().name)
            item("viewer-position").assertTextEquals(context.getString(R.string.df_media_position, 1, newestFirst.size))
            val photo = hasAnyAncestor(isDialog()) and hasContentDescription(newestFirst.first().name)
            screen.waitUntil(20_000) {
                screen.onAllNodes(photo, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
            }
            screen.onNode(photo, useUnmergedTree = true).performTouchInput { click() }
            screen.waitUntil(5_000) { screen.onAllNodesWithTag("viewer-title").fetchSemanticsNodes().isEmpty() }
            screen.onNode(photo, useUnmergedTree = true).performTouchInput { click() }
            awaitTag("viewer-title")
            item("viewer-previous").assertIsNotEnabled()
            item("viewer-next").performClick()
            item("viewer-title").assertTextEquals("clip.mp4")
            item("viewer-position").assertTextEquals(context.getString(R.string.df_media_position, 2, newestFirst.size))
            item("viewer-play-toggle").assertExists()
            item("viewer-previous").performClick()
            item("viewer-title").assertTextEquals(newestFirst.first().name)
            val back = context.getString(R.string.df_back)
            screen.onNode(hasAnyAncestor(isDialog()) and hasContentDescription(back)).performClick()
            screen.onNodeWithContentDescription(back).performClick()
            showAlbum(many)
            item("local-select:" + many.path).assertIsOff().performTouchInput { click() }.assertIsOn()
            item("local-media").assertDoesNotExist()

            showAlbum(bucket)
            item("local-album-path").assertDoesNotExist()
            screen.onNode(hasAnyAncestor(hasTestTag("local-album:" + bucket.path)) and
                hasText(requireNotNull(bucket.parent), substring = true), useUnmergedTree = true).assertDoesNotExist()
            assertCount(bucket, 2)
            item("local-select:" + bucket.path).assertIsOff()
            item("local-album:" + bucket.path).performClick()
            awaitTag("local-item:" + deepPhoto.path)
            item("local-item:" + directPhoto.path).assertIsDisplayed()
            item("local-item:" + other.path).assertDoesNotExist()
            item("local-item:" + ignoredPhoto.path).assertDoesNotExist()
            item("local-item:" + deepPhoto.path).performClick()
            awaitTag("local-media-detail")
            screen.onNode(hasAnyAncestor(isDialog()) and hasContentDescription(back)).performClick()
            screen.onNodeWithContentDescription(back).performClick()
            showAlbum(bucket)
            item("local-select:" + bucket.path).assertIsOff().performClick().assertIsOn()
            screen.onNodeWithText(context.getString(R.string.df_use_selected, 2)).performClick()
            item("local-albums").assertDoesNotExist()

            val reopened = SyncStorage(context, scope)
            try {
                val config = reopened.load()
                assertEquals(setOf(many.path, bucket.path), config.localFolders)
                assertEquals(setOf(bucket.path), config.recursiveFolders)
                assertEquals(10, config.maxDepth)
                screen.runOnIdle { plan = config; pickerOpen = true }
                showAlbum(many)
                item("local-select:" + many.path).assertIsOn()
                showAlbum(bucket)
                item("local-select:" + bucket.path).assertIsOn()
                screen.onNodeWithText(context.getString(R.string.df_all_files)).performClick()
                awaitTag("local-folders")
                screen.onNodeWithText(context.getString(R.string.df_media)).performClick()
                showAlbum(many)
                item("local-select:" + many.path).assertIsOn()
            } finally { reopened.close() }
        } finally {
            storage.close()
            root.deleteRecursively()
        }
    }

    /** Real creation and MediaStore insertion agree. Assign opposite mtimes to catch fallback-only sorting. */
    private fun createMediaInOrder(context: Context, files: List<File>) {
        val image = Bitmap.createBitmap(12, 10, Bitmap.Config.ARGB_8888)
        image.eraseColor(Color.BLUE)
        var previousAdded = 0L
        try {
            files.forEachIndexed { index, file ->
                val wait = (previousAdded + 1) * 1000 - System.currentTimeMillis()
                if (wait > 0) SystemClock.sleep(wait + 10)
                file.outputStream().use { output ->
                    if (file.extension == "mp4") {
                        InstrumentationRegistry.getInstrumentation().context.assets.open("local_album_frame.mp4").use { it.copyTo(output) }
                    } else check(image.compress(Bitmap.CompressFormat.JPEG, 85, output))
                }
                check(file.setLastModified(1_600_000_000_000L - index * 60_000L))
                val indexed = CompletableFuture<Uri?>()
                MediaScannerConnection.scanFile(context, arrayOf(file.path), null) { _, uri -> indexed.complete(uri) }
                val uri = requireNotNull(indexed.get(15, TimeUnit.SECONDS)) { "Media scanner skipped ${file.name}" }
                val field = MediaStore.MediaColumns.DATE_ADDED
                val added = requireNotNull(context.contentResolver.query(uri, arrayOf(field), null, null, null)).use {
                    check(it.moveToFirst())
                    it.getLong(0)
                }
                assertTrue("MediaStore creation times should increase for each fixture", added > previousAdded)
                previousAdded = added
            }
        } finally { image.recycle() }
    }
}
