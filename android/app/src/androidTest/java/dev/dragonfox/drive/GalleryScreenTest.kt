package dev.dragonfox.drive

import android.graphics.Bitmap
import android.media.ExifInterface
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.gallery.PhotoLoader
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.CloudFolder
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.FolderType
import dev.dragonfox.drive.ui.CloudBrowser
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GalleryScreenTest {
    @get:Rule val screen = createComposeRule()

    @Test fun openEncryptedPhotoAndChangeItsFolderType() {
        val server = InstrumentationRegistry.getArguments().getString("syncServer")
        assumeNotNull(server)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val username = "gallery" + UUID.randomUUID().toString().take(8)
        val password = UUID.randomUUID().toString()
        val api = DriveClient.register(requireNotNull(server), username, password) {}
        val loader = PhotoLoader(context, api)
        val album = api.createFolder(null, "Field photographs")
        val work = File(context.cacheDir, username).apply { mkdirs() }
        fun waitText(value: String) = screen.waitUntil(30_000) {
            screen.onAllNodesWithText(value).fetchSemanticsNodes().isNotEmpty()
        }

        try {
            val photo = File(work, "Lake.jpg")
            val bitmap = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888)
            try {
                bitmap.eraseColor(android.graphics.Color.BLUE)
                photo.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it)) }
            } finally { bitmap.recycle() }
            ExifInterface(photo.path).apply {
                setAttribute(ExifInterface.TAG_MODEL, "DragonFox test camera")
                saveAttributes()
            }
            api.upload(album.id, photo, "image/jpeg") {}
            screen.setContent {
                var folders by remember { mutableStateOf<List<CloudFolder>>(emptyList()) }
                var files by remember { mutableStateOf<List<CloudFile>>(emptyList()) }
                MaterialTheme {
                    CloudBrowser(folders, files, refresh = {
                        val listing = withContext(Dispatchers.IO) { api.listFolders() to api.listFiles() }
                        folders = listing.first
                        files = listing.second
                    }, changeType = { id, type ->
                        folders = withContext(Dispatchers.IO) { api.setFolderType(id, type); api.listFolders() }
                    }, loadPhoto = loader::load, onExit = {})
                }
            }
            waitText(album.name)
            screen.onNodeWithText(album.name).performClick()
            screen.waitUntil(30_000) { screen.onAllNodesWithContentDescription(photo.name).fetchSemanticsNodes().isNotEmpty() }
            screen.onNodeWithContentDescription(photo.name).performClick()
            screen.onNodeWithContentDescription(context.getString(R.string.df_camera_info)).performClick()
            waitText("DragonFox test camera")
            screen.onNodeWithText("DragonFox test camera").assertIsDisplayed()

            screen.onNodeWithContentDescription(context.getString(R.string.df_back)).performClick()
            screen.onNodeWithContentDescription(context.getString(R.string.df_folder_display)).performClick()
            screen.onNodeWithText(context.getString(R.string.df_folder_normal)).performClick()
            waitText(photo.name)
            val otherSession = DriveClient.login(requireNotNull(server), username, password) {}
            try { assertEquals(FolderType.NORMAL, otherSession.listFolders().single().type) }
            finally { otherSession.logout() }
        } finally {
            work.deleteRecursively()
            api.logout()
        }
    }
}
