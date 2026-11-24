package dev.dragonfox.drive.integration

import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.FolderType
import dev.dragonfox.drive.protocol.DriveSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Set DRAGONFOX_TEST_BINARY to the built Rust server to exercise the production HTTP path. */
class ServerInteropTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun registerLoginUploadAndDecryptAcrossSessions() {
        val binary = System.getenv("DRAGONFOX_TEST_BINARY")
        assumeTrue("Local Rust server binary required", !binary.isNullOrBlank())
        val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val server = "http://127.0.0.1:$port"
        val work = temp.newFolder("server")
        val builder = ProcessBuilder(File(binary!!).absolutePath).directory(work)
            .redirectErrorStream(true).redirectOutput(File(work, "server.log"))
        builder.environment()["DRAGONFOX__SERVER__HOST"] = "127.0.0.1"
        builder.environment()["DRAGONFOX__SERVER__PORT"] = port.toString()
        val process = builder.start()
        try {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (runCatching { URL("$server/api/config").readText() }.isFailure) {
                check(process.isAlive && System.nanoTime() < deadline) { "Test server failed to start" }
                Thread.sleep(50)
            }
            val password = UUID.randomUUID().toString()
            val username = "android_interop"
            val registered = DriveClient.register(server, username, password) {}
            val root = registered.createFolder(null, "手机同步")
            val album = registered.createFolder(root.id, "Pictures")
            registered.setFolderType(album.id, FolderType.PHOTOS)
            val sample = temp.newFile("星图.jpg")
            val bytes = ByteArray(4 * 1024 * 1024 + 253) { index -> (index % 251).toByte() }
            sample.writeBytes(bytes)
            var transferred = 0L
            val uploaded = registered.upload(album.id, sample, "image/jpeg") {
                transferred = it
            }
            assertEquals(sample.length(), transferred)
            val empty = temp.newFile("empty.txt")
            registered.upload(null, empty, "text/plain") {}
            registered.logout()

            lateinit var session: DriveSession
            DriveClient.login(server, username, password) { session = it }
            // A restored session can outlive its access token. The first request
            // must rotate the refresh token and persist the new token pair.
            val oldRefresh = session.refreshToken
            val expired = DriveSession(session.server, session.userId, session.username,
                session.masterKey, "expired-access-token", oldRefresh)
            val restored = DriveClient(expired) { session = it }
            val folders = restored.listFolders()
            assertTrue(oldRefresh != session.refreshToken)
            assertTrue(folders.any { it.name == "Pictures" && it.parentId == root.id && it.type == FolderType.PHOTOS })
            val listing = restored.listFiles()
            val copy = listing.single { it.id == uploaded.id }
            assertEquals(album.id, copy.parentId)
            assertEquals(sample.name, copy.name)
            assertEquals(sample.length(), copy.size)
            assertEquals(sha256(bytes), copy.sha256)
            // A current manifest has a hash, whereas earlier web uploads omitted it.
            // The viewer can still decrypt the complete original from this freshly restored account.
            val decrypted = MessageDigest.getInstance("SHA-256")
            restored.readFile(copy, {}) { decrypted.update(it); true }
            assertEquals(sha256(bytes), decrypted.digest().joinToString("") { "%02x".format(it) })
            restored.setFolderType(album.id, FolderType.AUTO)
            assertEquals(FolderType.AUTO, restored.listFolders().single { it.id == album.id }.type)
            val marker = listing.single { it.name == empty.name }
            assertEquals(null, marker.parentId)
            assertEquals(0L, marker.size)
            assertEquals(sha256(byteArrayOf()), marker.sha256)
            fun chunkSize(id: String, index: Int): Int {
                val connection = URL("$server/api/files/$id/chunks/$index").openConnection() as HttpURLConnection
                return try {
                    connection.setRequestProperty("Authorization", "Bearer " + session.accessToken)
                    connection.inputStream.use { it.readBytes().size }
                } finally {
                    connection.disconnect()
                }
            }
            assertEquals(4 * 1024 * 1024 + 16, chunkSize(copy.id, 0))
            assertEquals(253 + 16, chunkSize(copy.id, 1))
            assertEquals(16, chunkSize(marker.id, 0))
            restored.logout()
        } finally {
            process.destroy()
            if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly().waitFor()
        }
    }

    private fun sha256(input: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(input).joinToString("") { "%02x".format(it) }
}
