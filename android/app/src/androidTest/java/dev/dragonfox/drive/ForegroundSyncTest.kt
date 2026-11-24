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
        val source = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "sync-$id")

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
            val config = SyncConfig(setOf(source.absolutePath), destination.id, SyncMode.MEDIA, true)
            engine.configure(config)
            cycle { engine.setVisible(true) }
            val first = client.listFiles().single()
            assertEquals("photo.jpg", first.name)
            val parents = client.listFolders().associateBy { it.id }
            assertEquals("Mobile", generateSequence(parents[first.parentId]) { parents[it.parentId] }.last().name)

            File(source, "clip.mp4").writeBytes(byteArrayOf(0, 0, 0, 24, 102, 116, 121, 112))
            cycle { engine.rescan() }
            assertEquals(setOf("photo.jpg", "clip.mp4"), client.listFiles().map { it.name }.toSet())

            val delete = URL(server.trimEnd('/') + "/api/files/" + first.id).openConnection() as HttpURLConnection
            try {
                delete.requestMethod = "DELETE"
                delete.setRequestProperty("Authorization", "Bearer " + client.session.accessToken)
                assertTrue(delete.responseCode in 200..299)
            } finally { delete.disconnect() }
            cycle { engine.configure(config.copy(mode = SyncMode.ALL)) }
            val after = client.listFiles()
            assertEquals(listOf("clip.mp4", "notes.txt", "photo.jpg"), after.map { it.name }.sorted())
            assertNotEquals(first.id, after.single { it.name == "photo.jpg" }.id)
            cycle { engine.rescan() }
            assertEquals(after.map { it.id }.toSet(), client.listFiles().map { it.id }.toSet())
        } finally {
            engine.close()
            source.deleteRecursively()
        }
    }
}
