package dev.dragonfox.drive

import android.os.Environment
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.sync.FileAccess
import dev.dragonfox.drive.sync.SyncConfig
import dev.dragonfox.drive.sync.SyncEngine
import dev.dragonfox.drive.sync.SyncMode
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ForegroundSyncTest {
    @Test
    fun mediaAndAllFilesReconcileWithTheServer() = runBlocking(Dispatchers.IO) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val server = InstrumentationRegistry.getArguments().getString("syncServer")
        assumeNotNull(server)
        val context = instrumentation.targetContext
        assertTrue("Grant All files access to the debug build before running syncServer tests", FileAccess.granted(context))
        verifyUploads(context, requireNotNull(server))
    }

    private suspend fun verifyUploads(context: android.content.Context, server: String) {
        val id = UUID.randomUUID().toString().replace("-", "").take(14)
        val client = DriveClient.register(server, "sync$id", UUID.randomUUID().toString()) {}
        val destination = client.createFolder(null, "Mobile")
        val engine = SyncEngine(context, client, "device-test-$id")
        val fixture = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "sync-$id")
        val source = File(fixture, "direct")

        suspend fun cycle(trigger: () -> Unit) = withTimeout(60_000L) {
            coroutineScope {
                val started = async(start = CoroutineStart.UNDISPATCHED) { engine.status.first { it.running } }
                trigger()
                started.await()
                val finished = engine.status.first { !it.running }
                assertTrue(finished.errors.toString(), finished.errors.isEmpty())
            }
        }

        try {
            assertTrue(source.mkdirs())
            File(source, "photo.jpg").writeBytes(byteArrayOf(-1, -40, -1, -39))
            File(source, "notes.txt").writeText("Field log")
            val config = SyncConfig(setOf(source.absolutePath), destination.id, SyncMode.MEDIA, true, maxDepth = 10)
            engine.configure(config)
            cycle { engine.setVisible(true) }
            val first = client.listFiles().single()
            assertEquals("photo.jpg", first.name)
            val parents = client.listFolders().associateBy { it.id }
            assertEquals("Mobile", generateSequence(parents[first.parentId]) { parents[it.parentId] }.last().name)

            File(source, "clip.mp4").writeBytes(byteArrayOf(0, 0, 0, 24, 102, 116, 121, 112))
            val unselectedChild = File(source, "child").apply { check(mkdir()) }
            File(unselectedChild, "direct-child.jpg").writeText("only when all files is enabled")
            val boundary = File(fixture, "albums/boundary")
            val descendants = File(boundary, "year/trip").apply { check(mkdirs()) }
            File(boundary, "repeat.jpg").writeText("at the boundary")
            File(descendants, "repeat.jpg").writeText("two levels further down")
            File(descendants, "private.txt").writeText("skip non-media")
            val neighbour = File(fixture, "albums/neighbour").apply { check(mkdir()) }
            File(neighbour, "neighbour.jpg").writeText("skip unselected albums")
            cycle { engine.rescan() }
            assertEquals(setOf("photo.jpg", "clip.mp4"), client.listFiles().map { it.name }.toSet())

            val scoped = config.copy(localFolders = setOf(source.absolutePath, boundary.absolutePath),
                recursiveFolders = setOf(boundary.absolutePath))
            cycle { engine.configure(scoped) }
            val folders = client.listFolders().associateBy { it.id }
            val paths = client.listFiles().map { file ->
                val parentNames = generateSequence(folders[file.parentId]) { folders[it.parentId] }.map { it.name }.toList().asReversed()
                (parentNames + file.name).joinToString("/")
            }
            val base = "Mobile/${Environment.DIRECTORY_DOWNLOADS}/${fixture.name}"
            assertEquals(listOf("$base/direct/photo.jpg", "$base/direct/clip.mp4",
                "$base/albums/boundary/repeat.jpg", "$base/albums/boundary/year/trip/repeat.jpg").sorted(), paths.sorted())

            // Volume/Download/fixture/albums/boundary reaches level 5. Only new files
            // at or above this boundary should reach the server during a timed check.
            cycle { engine.configure(scoped.copy(maxDepth = 5, intervalSeconds = 5)) }
            File(descendants, "above-limit.jpg").writeText("exclude this new deep media")
            File(boundary, "at-limit.jpg").writeText("upload this new media")
            cycle { /* The foreground engine's next automatic check drives this cycle. */ }
            val timed = client.listFiles()
            assertEquals(listOf("at-limit.jpg", "clip.mp4", "photo.jpg", "repeat.jpg", "repeat.jpg"),
                timed.map { it.name }.sorted())
            val boundaryId = folders.entries.single { it.value.name == boundary.name }.key
            assertEquals(boundaryId, timed.single { it.name == "at-limit.jpg" }.parentId)

            val delete = URL(server.trimEnd('/') + "/api/files/" + first.id).openConnection() as HttpURLConnection
            try {
                delete.requestMethod = "DELETE"
                delete.setRequestProperty("Authorization", "Bearer " + client.session.accessToken)
                assertTrue(delete.responseCode in 200..299)
            } finally { delete.disconnect() }
            cycle { engine.configure(config.copy(mode = SyncMode.ALL)) }
            val after = client.listFiles()
            assertEquals(listOf("at-limit.jpg", "clip.mp4", "direct-child.jpg", "notes.txt", "photo.jpg", "repeat.jpg", "repeat.jpg"), after.map { it.name }.sorted())
            assertNotEquals(first.id, after.single { it.name == "photo.jpg" }.id)
            cycle { engine.rescan() }
            assertEquals(after.map { it.id }.toSet(), client.listFiles().map { it.id }.toSet())
        } finally {
            engine.close()
            fixture.deleteRecursively()
        }
    }
}
