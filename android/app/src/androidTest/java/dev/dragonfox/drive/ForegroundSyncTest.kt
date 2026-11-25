package dev.dragonfox.drive

import android.os.Environment
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.sync.FileAccess
import dev.dragonfox.drive.sync.FolderScanner
import dev.dragonfox.drive.sync.SyncConfig
import dev.dragonfox.drive.sync.SyncEngine
import dev.dragonfox.drive.sync.SyncMode
import dev.dragonfox.drive.sync.SyncStorage
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
        val accountScope = "device-test-$id"
        var engine = SyncEngine(context, client, accountScope)
        val fixture = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "sync-$id")
        val source = File(fixture, "旅行")

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
            val beijing = File(source, "北京").apply { check(mkdir()) }
            val shanghai = File(source, "上海").apply { check(mkdir()) }
            val hutongs = File(beijing, "胡同").apply { check(mkdir()) }
            File(beijing, "beijing.jpg").writeText("selected child")
            File(shanghai, "shanghai.jpg").writeText("unselected sibling")
            File(hutongs, "hutong.jpg").writeText("below the hard limit of five")
            val boundary = File(fixture, "albums/boundary")
            val descendants = File(boundary, "year/trip").apply { check(mkdirs()) }
            File(boundary, "repeat.jpg").writeText("at the boundary")
            File(descendants, "repeat.jpg").writeText("two levels further down")
            File(descendants, "private.txt").writeText("skip non-media")
            val neighbour = File(fixture, "albums/neighbour").apply { check(mkdir()) }
            File(neighbour, "neighbour.jpg").writeText("skip unselected albums")
            cycle { engine.rescan() }
            assertEquals(setOf("photo.jpg", "clip.mp4"), client.listFiles().map { it.name }.toSet())

            val scanner = FolderScanner(context)
            val shallow = scanner.mediaBuckets(5).filter { it.directory in setOf(source, beijing, shanghai) }
            assertEquals(setOf(source, beijing, shanghai), shallow.map { it.directory }.toSet())
            assertTrue(shallow.none { it.recursive })
            val chosen = shallow.filter { it.directory != shanghai }.map { it.directory.path }.toSet()
            cycle { engine.configure(config.copy(localFolders = chosen, maxDepth = 5)) }
            assertEquals(listOf("beijing.jpg", "clip.mp4", "photo.jpg"), client.listFiles().map { it.name }.sorted())

            val selected = scanner.mediaBuckets(config.maxDepth).filter { it.directory == source || it.directory == boundary }
            assertEquals(setOf(source, boundary), selected.map { it.directory }.toSet())
            val scoped = config.copy(localFolders = selected.map { it.directory.path }.toSet(),
                recursiveFolders = selected.filter { it.recursive }.map { it.directory.path }.toSet())
            assertEquals(setOf(boundary.path), scoped.recursiveFolders)
            cycle { engine.configure(scoped) }
            val folders = client.listFolders().associateBy { it.id }
            val paths = client.listFiles().map { file ->
                val parentNames = generateSequence(folders[file.parentId]) { folders[it.parentId] }.map { it.name }.toList().asReversed()
                (parentNames + file.name).joinToString("/")
            }
            val base = "Mobile/${Environment.DIRECTORY_DOWNLOADS}/${fixture.name}"
            assertEquals(listOf("$base/旅行/photo.jpg", "$base/旅行/clip.mp4", "$base/旅行/北京/beijing.jpg",
                "$base/albums/boundary/repeat.jpg", "$base/albums/boundary/year/trip/repeat.jpg").sorted(), paths.sorted())

            // Volume/Download/fixture/albums/boundary reaches level 5. Only new files
            // at or above this boundary should reach the server during a timed check.
            cycle { engine.configure(scoped.copy(maxDepth = 5, intervalSeconds = 5)) }
            File(descendants, "above-limit.jpg").writeText("exclude this new deep media")
            File(boundary, "at-limit.jpg").writeText("upload this new media")
            cycle { /* The foreground engine's next automatic check drives this cycle. */ }
            val timed = client.listFiles()
            assertEquals(listOf("at-limit.jpg", "beijing.jpg", "clip.mp4", "photo.jpg", "repeat.jpg", "repeat.jpg"),
                timed.map { it.name }.sorted())
            val boundaryId = folders.entries.single { it.value.name == boundary.name }.key
            assertEquals(boundaryId, timed.single { it.name == "at-limit.jpg" }.parentId)

            // Older releases saved recursive album selections even above level five.
            // Reopen an account with that persisted rule and verify newly discovered descendants.
            engine.setVisible(false)
            val historical = SyncStorage(context, accountScope)
            try { historical.save(config.copy(recursiveFolders = setOf(source.path))) }
            finally { historical.close() }
            val previous = engine
            engine = SyncEngine(context, client, accountScope)
            previous.close()
            cycle { engine.setVisible(true) }
            val legacyMedia = listOf("at-limit.jpg", "beijing.jpg", "clip.mp4", "hutong.jpg", "photo.jpg",
                "repeat.jpg", "repeat.jpg", "shanghai.jpg")
            assertEquals(legacyMedia, client.listFiles().map { it.name }.sorted())

            val delete = URL(server.trimEnd('/') + "/api/files/" + first.id).openConnection() as HttpURLConnection
            try {
                delete.requestMethod = "DELETE"
                delete.setRequestProperty("Authorization", "Bearer " + client.session.accessToken)
                assertTrue(delete.responseCode in 200..299)
            } finally { delete.disconnect() }
            cycle { engine.configure(config.copy(mode = SyncMode.ALL)) }
            val after = client.listFiles()
            assertEquals((legacyMedia + "notes.txt").sorted(), after.map { it.name }.sorted())
            assertNotEquals(first.id, after.single { it.name == "photo.jpg" }.id)
            cycle { engine.rescan() }
            assertEquals(after.map { it.id }.toSet(), client.listFiles().map { it.id }.toSet())
        } finally {
            engine.close()
            fixture.deleteRecursively()
        }
    }
}
