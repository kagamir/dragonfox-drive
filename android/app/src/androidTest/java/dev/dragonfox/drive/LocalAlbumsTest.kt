package dev.dragonfox.drive

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Environment
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
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
        val many = File(root, "Zeta").apply { check(mkdirs()) }
        val bucket = File(root, "4/5").apply { check(mkdirs()) }
        val deep = File(bucket, "6/7/8/9").apply { check(mkdirs()) }
        val beyondLimit = File(deep, "10/11").apply { check(mkdirs()) }
        val scanner = FolderScanner(context)
        val storage = SyncStorage(context, scope)
        val covers = (1..5).map { File(many, "image-$it.jpg") }
        val directPhoto = File(bucket, "direct.jpg")
        val deepPhoto = File(deep, "deep.jpg")
        val ignoredPhoto = File(beyondLimit, "out-of-range.jpg")
        val other = File(deep, "excluded.txt")
        try {
            val image = Bitmap.createBitmap(12, 10, Bitmap.Config.ARGB_8888)
            try {
                image.eraseColor(Color.BLUE)
                for (file in covers + directPhoto + deepPhoto + ignoredPhoto) {
                    file.outputStream().use { check(image.compress(Bitmap.CompressFormat.JPEG, 80, it)) }
                }
            } finally { image.recycle() }
            other.writeText("not media")

            val head = runBlocking {
                val albums = scanner.mediaBuckets(10).filter { it.directory.toPath().startsWith(root.toPath()) }
                assertEquals(listOf(many, bucket), albums.map { it.directory })
                assertEquals(5, albums.first().count)
                assertFalse(albums.first().recursive)
                assertEquals(4, albums.first().covers.distinct().size)
                val aggregate = albums.last()
                assertEquals(2, aggregate.count)
                assertTrue(aggregate.recursive)
                assertEquals(setOf(directPhoto, deepPhoto), scanner.mediaPage(aggregate, 0, 10).toSet())
                val shallow = scanner.mediaBuckets(5).single { it.directory == bucket }
                assertEquals(1, shallow.count)
                assertEquals(listOf(directPhoto), shallow.covers)
                assertEquals(listOf(directPhoto), scanner.mediaPage(shallow, 0, 10))
                albums.first()
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
            showAlbum(many)
            val index = item("local-albums").fetchSemanticsNode().config[SemanticsProperties.IndexForKey]
            assertTrue("The larger album is listed first", index(many.path) in 0 until index(bucket.path))
            assertCount(many, 5)
            head.covers.forEach { item("local-cover:" + it.path).assertIsDisplayed() }
            covers.filterNot { it in head.covers }.forEach { item("local-cover:" + it.path).assertDoesNotExist() }
            item("local-select:" + many.path).assertIsOff().performTouchInput { click() }.assertIsOn()
            item("local-media").assertDoesNotExist()

            showAlbum(bucket)
            assertCount(bucket, 2)
            item("local-select:" + bucket.path).assertIsOff()
            item("local-album:" + bucket.path).performClick()
            awaitTag("local-item:" + deepPhoto.path)
            item("local-item:" + directPhoto.path).assertIsDisplayed()
            item("local-item:" + other.path).assertDoesNotExist()
            item("local-item:" + ignoredPhoto.path).assertDoesNotExist()
            item("local-item:" + deepPhoto.path).performClick()
            awaitTag("local-media-detail")
            val back = context.getString(R.string.df_back)
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
                fun showFolder(folder: File) {
                    screen.waitUntil(30_000) {
                        screen.onAllNodesWithTag("local-folders").fetchSemanticsNodes().any { list ->
                            SemanticsProperties.IndexForKey in list.config &&
                                list.config[SemanticsProperties.IndexForKey](folder.path) >= 0
                        }
                    }
                    item("local-folders").performScrollToKey(folder.path)
                }
                // The all-files browser exposes the same five display levels even at N=10.
                for (folder in listOf(requireNotNull(downloads.parentFile), downloads, root, requireNotNull(bucket.parentFile))) {
                    showFolder(folder)
                    item("local-open:" + folder.path).performClick()
                }
                showFolder(bucket)
                item("local-select:" + bucket.path).assertIsOff().performClick().assertIsOn()
                item("local-open:" + bucket.path).assertDoesNotExist()
                screen.onNodeWithText(context.getString(R.string.df_media)).performClick()
                showAlbum(many)
                item("local-select:" + many.path).assertIsOn()
            } finally { reopened.close() }
        } finally {
            storage.close()
            root.deleteRecursively()
        }
    }
}
