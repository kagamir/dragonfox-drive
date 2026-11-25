package dev.dragonfox.drive

import android.graphics.Bitmap
import android.graphics.pdf.PdfDocument
import android.os.Environment
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
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
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToKey
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.sync.FileAccess
import dev.dragonfox.drive.sync.SyncMode
import dev.dragonfox.drive.ui.LocalPicker
import java.io.File
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LocalFileBrowserTest {
    @get:Rule val screen = createComposeRule()

    @Test fun folderRowsOpenCheckboxesSelectAndBoundaryFilesPreviewInPlace() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue("Grant all-files access to the debug build", FileAccess.granted(context))
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val fixture = File(downloads, "browser-" + UUID.randomUUID())
        val parent = File(fixture, "行程")
        val boundary = File(parent, "第五层").apply { check(mkdirs()) }
        val note = File(boundary, "行程.txt")
        val photo = File(boundary, "photo.jpg")
        val pdf = File(boundary, "路线.pdf")
        val binary = File(boundary, "sample.dfunknown")
        val hidden = File(boundary, "第六层").apply { check(mkdir()) }
        val text = "北京到上海 · 08:30"
        var saved: Pair<SyncMode, Set<String>>? = null
        try {
            note.writeText(text)
            binary.writeBytes(byteArrayOf(0, -1, 1, 0))
            File(hidden, "hidden.txt").writeText("deeper than the configured limit")
            val bitmap = Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888)
            try { photo.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it)) } }
            finally { bitmap.recycle() }
            val document = PdfDocument()
            try {
                for (number in 1..2) {
                    val page = document.startPage(PdfDocument.PageInfo.Builder(160, 200, number).create())
                    page.canvas.drawColor(if (number == 1) android.graphics.Color.BLUE else android.graphics.Color.RED)
                    document.finishPage(page)
                }
                pdf.outputStream().use(document::writeTo)
            } finally { document.close() }
            val tail = (1..24).map { File(boundary, "zz-%02d.txt".format(it)).apply { writeText("item $it") } }.last()
            screen.setContent {
                MaterialTheme {
                    LocalPicker(SyncMode.ALL, emptySet(), emptySet(), 5, true, {}, {}) { mode, paths, _ ->
                        saved = mode to paths
                    }
                }
            }
            fun item(tag: String) = screen.onNodeWithTag(tag, useUnmergedTree = true)
            fun awaitTag(tag: String) = screen.waitUntil(30_000) {
                screen.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
            }
            fun show(entry: File) {
                screen.waitUntil(30_000) {
                    screen.onAllNodesWithTag("local-folders").fetchSemanticsNodes().any { list ->
                        SemanticsProperties.IndexForKey in list.config && list.config[SemanticsProperties.IndexForKey](entry.path) >= 0
                    }
                }
                item("local-folders").performScrollToKey(entry.path)
            }
            fun open(file: File, expected: String) {
                show(file)
                item("local-file:" + file.path).performClick()
                awaitTag(expected)
            }
            fun closePreview() {
                val back = hasAnyAncestor(isDialog()) and hasContentDescription(context.getString(R.string.df_back))
                screen.onNode(back).performClick()
                awaitTag("local-folders")
            }
            val volume = requireNotNull(downloads.parentFile)
            show(volume)
            item("local-parent").assertDoesNotExist()
            for (folder in listOf(volume, downloads, fixture, parent)) {
                show(folder)
                item("local-select:" + folder.path).assertIsOff()
                item("local-open:" + folder.path).performClick()
            }
            show(boundary)
            item("local-select:" + boundary.path).assertIsOff().performTouchInput { click() }.assertIsOn()
            item("local-open:" + boundary.path).assertIsDisplayed()
            screen.onNode(hasText(boundary.name) and hasAnyAncestor(hasTestTag("local-open:" + boundary.path)),
                useUnmergedTree = true).performTouchInput { click() }
            show(note)
            val keys = item("local-folders").fetchSemanticsNode().config[SemanticsProperties.IndexForKey]
            assertTrue(listOf(note, pdf, photo, binary).all { keys(it.path) >= 0 })
            assertEquals(-1, keys(hidden.path))
            assertEquals(-1, keys(File(hidden, "hidden.txt").path))

            open(note, "file-text-content")
            screen.onNodeWithText(text, substring = true, useUnmergedTree = true).assertIsDisplayed()
            closePreview()
            open(photo, "local-media-detail")
            awaitTag("viewer-title")
            closePreview()
            open(pdf, "file-pdf-page")
            fun awaitPage(number: Int) {
                val page = hasTestTag("file-pdf-page") and hasContentDescription(context.getString(R.string.df_page_count, number, 2))
                screen.waitUntil(20_000) { screen.onAllNodes(page, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
            }
            awaitPage(1)
            item("file-pdf-previous").assertIsNotEnabled()
            item("file-pdf-next").assertIsEnabled().performClick()
            awaitPage(2)
            item("file-pdf-next").assertIsNotEnabled()
            item("file-pdf-previous").assertIsEnabled()
            closePreview()
            open(binary, "file-preview-unsupported")
            closePreview()

            show(tail)
            item("local-parent").assertIsDisplayed().performClick()
            show(boundary)
            item("local-select:" + boundary.path).assertIsOn()
            item("local-parent").performClick()
            show(parent)
            item("local-select:" + parent.path).assertIsOff()
            screen.onNodeWithText(context.getString(R.string.df_use_selected, 1)).performClick()
            screen.runOnIdle { assertEquals(SyncMode.ALL to setOf(boundary.path), saved) }
        } finally { fixture.deleteRecursively() }
    }
}
