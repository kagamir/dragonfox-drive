package dev.dragonfox.drive.protocol

import dev.dragonfox.drive.gallery.sampleSize
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class GalleryTest {
    private val key = ByteArray(32) { it.toByte() }

    @Test fun bothClientsReadTheSameFolderTypeCiphertexts() {
        val iv = WireCrypto.unb64("AAECAwQFBgcICQoL")
        fun open(text: String) = WireCrypto.open(key, WireCrypto.unb64(text), iv).decodeToString()
        assertEquals("photos", open("N2q5b6qWUC8paaRe/2ZzmDDTvu7nMg=="))
        assertEquals("normal", open("KW2kdqSJcg8OSOaYlf+s5Iew1e4rjg=="))
    }

    @Test fun classifyByDirectImageMajorityWithExplicitMimeTakingPriority() {
        fun file(name: String, mime: String) = CloudFile("abc", "folder", name, 10, mime = mime)
        val raw = file("NIGHT.RAF", "application/octet-stream; q=1")
        val photo = file("no extension", " Image/JPEG; charset=binary")
        val video = file("movie.jpg", "video/mp4")
        assertTrue(raw.isImage)
        assertTrue(photo.isImage)
        assertFalse(video.isImage)
        assertFalse(shouldShowPhotos(FolderType.AUTO, emptyList()))
        assertFalse(shouldShowPhotos(FolderType.AUTO, listOf(raw, video)))
        assertTrue(shouldShowPhotos(FolderType.AUTO, listOf(raw, photo, video)))
        assertFalse(shouldShowPhotos(FolderType.NORMAL, listOf(photo)))
        assertTrue(shouldShowPhotos(FolderType.PHOTOS, emptyList()))
    }

    @Test fun sampledDecodeBoundsMemoryAndLongEdge() {
        assertEquals(1, sampleSize(120, 200, 384, 1_000_000))
        assertEquals(4, sampleSize(1024, 769, 384, 1_000_000))
        assertEquals(8, sampleSize(8032, 6016, 2560, 1_000_000))
    }

    @Test fun oldAndCurrentPhotosReadOnlyWhenOpenedAndAuthenticateTheirChunks() {
        MockWebServer().use { server ->
            val iv = WireCrypto.random(12)
            val contentId = "de".repeat(16)
            val plain = byteArrayOf(1, 2, 3)
            val cipher = WireCrypto.chunk(key, iv, 0, contentId, plain)
            val rows = JSONArray()
            for (id in listOf("old", "current")) {
                val manifest = JSONObject().put("name", "legacy.jpeg").put("size", plain.size)
                    .put("mime", "application/octet-stream").put("iv_base", WireCrypto.b64(iv)).put("content_id", contentId)
                if (id == "current") manifest.put("plaintext_sha256", "ab".repeat(32))
                val enc = WireCrypto.seal(key, WireCrypto.pad(manifest.toString().toByteArray(), 256))
                val wrap = WireCrypto.seal(key, key)
                rows.put(JSONObject().put("id", id).put("status", "ready").put("chunk_count", 1)
                    .put("encrypted_file_key", WireCrypto.b64(wrap.bytes)).put("encrypted_file_key_nonce", WireCrypto.b64(wrap.iv))
                    .put("encrypted_manifest", WireCrypto.b64(enc.bytes)).put("encrypted_manifest_nonce", WireCrypto.b64(enc.iv)))
            }
            server.enqueue(MockResponse().setBody(JSONObject().put("files", rows).toString()))
            repeat(2) { server.enqueue(MockResponse().setBody(Buffer().write(cipher))) }
            server.enqueue(MockResponse().setBody(Buffer().write(cipher.copyOf(2))))
            server.start()
            val client = DriveClient(DriveSession(server.url("/").toString(), "u", "test", WireCrypto.b64(key), "at", "rt")) {}
            val files = client.listFiles()
            assertEquals(1, server.requestCount)
            for (file in files) {
                assertTrue(file.isImage)
                client.readFile(file, {}) { assertArrayEquals(plain, it); true }
            }
            assertThrows(IOException::class.java) { client.readFile(files.first(), {}) { fail("Truncated response"); true } }
            assertThrows(IOException::class.java) { client.readFile(files.first().copy(revision = "stale"), {}) { true } }
            assertEquals(4, server.requestCount)
        }
    }

    @Test fun folderOverridesRoundTripAndDetectUnsupportedServers() {
        MockWebServer().use { server ->
            fun sealed(row: JSONObject, field: String, key: ByteArray, bytes: ByteArray) {
                val s = WireCrypto.seal(key, bytes)
                row.put(field, WireCrypto.b64(s.bytes)).put(field + "_nonce", WireCrypto.b64(s.iv))
            }
            val folderKey = WireCrypto.random(32)
            val row = JSONObject().put("id", "f")
            sealed(row, "encrypted_folder_key", key, folderKey)
            sealed(row, "encrypted_name", folderKey, WireCrypto.pad("Album".toByteArray(), 32))
            sealed(row, "encrypted_type", folderKey, "normal".toByteArray())
            server.enqueue(MockResponse().setBody(JSONObject().put("folders", JSONArray().put(row)).toString()))
            server.enqueue(MockResponse().setBody("""{"ok":true,"folder_type_updated":true}"""))
            server.enqueue(MockResponse().setBody("""{"ok":true,"folder_type_updated":true}"""))
            server.enqueue(MockResponse().setBody("""{"ok":true}"""))
            server.start()
            val client = DriveClient(DriveSession(server.url("/").toString(), "u", "test", WireCrypto.b64(key), "at", "rt")) {}
            assertEquals(FolderType.NORMAL, client.listFolders().single().type)
            server.takeRequest()
            client.setFolderType("f", FolderType.PHOTOS)
            val patch = server.takeRequest()
            assertEquals("PATCH", patch.method)
            assertEquals("/api/folders/f", patch.path)
            val json = JSONObject(patch.body.readUtf8())
            assertEquals("photos", WireCrypto.open(folderKey, WireCrypto.unb64(json.getString("encrypted_type")),
                WireCrypto.unb64(json.getString("encrypted_type_nonce"))).decodeToString())
            client.setFolderType("f", FolderType.AUTO)
            val auto = JSONObject(server.takeRequest().body.readUtf8())
            assertTrue(auto.has("encrypted_type") && auto.isNull("encrypted_type"))
            assertTrue(auto.has("encrypted_type_nonce") && auto.isNull("encrypted_type_nonce"))
            assertThrows(IOException::class.java) { client.setFolderType("f", FolderType.NORMAL) }
        }
    }
}
