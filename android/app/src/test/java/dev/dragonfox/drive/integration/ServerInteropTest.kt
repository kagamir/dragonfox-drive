package dev.dragonfox.drive.integration

import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.FolderType
import dev.dragonfox.drive.protocol.DriveSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
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
        withTestServer(temp.newFolder("server")) { server ->
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
        }
    }

    @Test fun manageEncryptedTreeAcrossSessionsAndDeleteOnlyItsMembers() {
        withTestServer(temp.newFolder("tree")) { server ->
            val client = DriveClient.register(server, "android_tree", UUID.randomUUID().toString()) {}
            val keep = client.createFolder(null, "保留")
            val folder = client.createFolder(null, "项目")
            val child = client.createFolder(folder.id, "内部资料")
            val deep = client.createFolder(child.id, "子目录")
            client.setFolderType(child.id, FolderType.NORMAL)
            val bytes = "UTF-8 数据 \n第二行".toByteArray()
            val text = client.uploadStream(deep.id, "notes.txt", bytes.size.toLong(), "text/plain",
                { bytes.inputStream() }, {})
            val empty = client.createTextFile(null, "empty.txt")
            val sibling = client.createTextFile(keep.id, "keep.txt", "unchanged")
            val before = client.fileMaterial(text)
            val oldManifest = before.row.getString("encrypted_manifest")
            val oldKeyEnvelope = before.row.getString("encrypted_file_key")

            client.moveFile(text.id, null)
            val atRoot = client.listFiles().single { it.id == text.id }
            assertEquals(null, atRoot.parentId)
            val moved = client.fileMaterial(atRoot)
            assertEquals(oldManifest, moved.row.getString("encrypted_manifest"))
            assertNotEquals(oldKeyEnvelope, moved.row.getString("encrypted_file_key"))
            assertTrue(before.key.contentEquals(moved.key))
            client.moveFile(text.id, deep.id)
            client.renameFile(text.id, "新名称.txt")
            assertThrows(IOException::class.java) { client.fileMaterial(text) }

            client.renameFolder(child.id, "改名目录")
            assertThrows(IllegalArgumentException::class.java) { client.moveFolder(folder.id, deep.id) }
            assertThrows(IllegalArgumentException::class.java) { client.moveFolder(child.id, child.id) }
            client.moveFolder(child.id, null)
            client.moveFolder(child.id, keep.id)
            val restored = DriveClient(client.session) {}
            val folders = restored.listFolders()
            assertTrue(folders.any { it.id == child.id && it.name == "改名目录" && it.parentId == keep.id && it.type == FolderType.NORMAL })
            assertTrue(folders.any { it.id == deep.id && it.parentId == child.id })
            val files = restored.listFiles()
            val renamed = files.single { it.id == text.id }
            assertEquals("新名称.txt", renamed.name)
            assertEquals("text/plain", renamed.mime)
            assertEquals(text.sha256, renamed.sha256)
            assertEquals(text.createdAt, renamed.createdAt)
            assertEquals(deep.id, renamed.parentId)
            val after = ByteArrayOutputStream()
            restored.readFile(renamed, {}) { after.write(it); true }
            assertTrue(bytes.contentEquals(after.toByteArray()))
            val emptyContent = ByteArrayOutputStream()
            restored.readFile(files.single { it.id == empty.id }, {}) { emptyContent.write(it); true }
            assertEquals(0, emptyContent.size())

            // An interrupted foreign upload has no manifest, but still belongs to this subtree.
            val row = restored.fileMaterial(renamed).row
            val pending = JSONObject().put("total_size", 1).put("chunk_count", 1)
            for (field in listOf("encrypted_parent_id", "encrypted_parent_id_nonce", "encrypted_file_key", "encrypted_file_key_nonce")) {
                pending.put(field, row.getString(field))
            }
            val incomplete = restored.json("POST", "/api/files", pending).getString("id")
            restored.deleteFolder(child.id)
            val survivors = restored.listFolders().map { it.id }.toSet()
            assertEquals(setOf(keep.id, folder.id), survivors)
            assertEquals(setOf(empty.id, sibling.id), restored.listFiles().map { it.id }.toSet())
            val raw = restored.json("GET", "/api/files").getJSONArray("files")
            assertTrue((0 until raw.length()).none { raw.getJSONObject(it).getString("id") == incomplete })
            restored.deleteFile(empty.id)
            assertEquals(listOf(sibling.id), restored.listFiles().map { it.id })
        }
    }

    @Test fun activeUploadIsProtectedAndWrongSourceLengthCleansTheSlot() {
        withTestServer(temp.newFolder("streams")) { server ->
            val client = DriveClient.register(server, "android_stream", UUID.randomUUID().toString()) {}
            val target = client.createFolder(null, "Transfer")
            val file = client.uploadStream(target.id, "readme.bin", 2, "application/octet-stream", {
                assertThrows(IOException::class.java) { client.deleteFolder(target.id) }
                byteArrayOf(1, 2).inputStream()
            }, {})
            assertThrows(IOException::class.java) {
                client.uploadStream(target.id, "short.bin", 3, "application/octet-stream",
                    { byteArrayOf(1).inputStream() }, {})
            }
            assertEquals(listOf(file.id), client.listFiles().map { it.id })
            assertEquals(1, client.json("GET", "/api/files").getJSONArray("files").length())
            client.deleteFolder(target.id)
            assertTrue(client.listFiles().isEmpty())
        }
    }

    @Test fun concurrentTreeChangesRefreshTheDestinationWithoutCreatingOrphans() {
        withTestServer(temp.newFolder("conflicts")) { server ->
            val first = DriveClient.register(server, "android_conflicts", UUID.randomUUID().toString()) {}
            val target = first.createFolder(null, "target")
            val peer = DriveClient(first.session) {}
            first.listFolders()
            peer.createFolder(null, "unrelated")
            // An unrelated change invalidates the snapshot. The original destination still exists.
            val kept = first.createTextFile(target.id, "once.txt", "once")
            assertEquals(listOf(kept.id), first.listFiles().map { it.id })
            first.listFolders()
            peer.deleteFolder(target.id)
            assertThrows(IOException::class.java) { first.createTextFile(target.id, "orphan.txt") }
            assertThrows(IOException::class.java) { first.createFolder(target.id, "orphan") }
            assertTrue(first.listFiles().isEmpty())
            assertEquals(listOf("unrelated"), first.listFolders().map { it.name })
        }
    }

    private fun sha256(input: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(input).joinToString("") { "%02x".format(it) }
}

internal fun withTestServer(work: File, test: (String) -> Unit) {
    val binary = System.getenv("DRAGONFOX_TEST_BINARY")
    assumeTrue("Local Rust server binary required", !binary.isNullOrBlank())
    val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
    val server = "http://127.0.0.1:$port"
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
        test(server)
    } finally {
        process.destroy()
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly().waitFor()
    }
}
