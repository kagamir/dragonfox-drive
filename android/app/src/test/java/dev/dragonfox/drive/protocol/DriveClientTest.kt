package dev.dragonfox.drive.protocol

import android.os.Build
import dev.dragonfox.drive.BuildConfig
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.io.File
import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DriveClientTest {
    private val master = ByteArray(32) { it.toByte() }

    private fun session(base: String) = DriveSession(base, "user", "alice", WireCrypto.b64(master), "old", "refresh")

    private fun reply(status: Int, json: String) = MockResponse().setResponseCode(status).setBody(json)

    private fun withServer(handler: (RecordedRequest) -> MockResponse, test: (String) -> Unit) {
        val failed = AtomicReference<Throwable?>()
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse =
                    try {
                        handler(request)
                    } catch (e: Throwable) {
                        failed.compareAndSet(null, e)
                        reply(500, "{}")
                    }
            }
            server.start()
            test(server.url("/").toString().trimEnd('/'))
            failed.get()?.let { throw it }
        }
    }

    @Test fun sendsInstalledAppVersionAndAndroidRelease() {
        val product = "DragonFoxDrive/${BuildConfig.VERSION_NAME}"
        assertEquals("$product (Android 15)", androidUserAgent("15"))
        assertEquals("$product (Android)", androidUserAgent(null))
        assertEquals("$product (Android)", androidUserAgent("15\ninvalid"))
        withServer({ request ->
            assertEquals(androidUserAgent(Build.VERSION.RELEASE), request.getHeader("User-Agent"))
            reply(200, """{"files":[]}""")
        }) { base -> DriveClient(session(base)) {}.listFiles() }
    }

    @Test fun concurrentExpiredRequestsShareOneRefresh() {
        val staleRequests = CountDownLatch(2)
        val refreshes = AtomicInteger()
        val saves = AtomicInteger()
        withServer({ request ->
            when (request.path) {
                "/api/files" -> if (request.getHeader("Authorization") == "Bearer old") {
                    staleRequests.countDown()
                    assertTrue(staleRequests.await(5, TimeUnit.SECONDS))
                    reply(401, "{}")
                } else {
                    assertEquals("Bearer fresh", request.getHeader("Authorization"))
                    reply(200, """{"files":[]}""")
                }
                "/api/auth/refresh" -> {
                    refreshes.incrementAndGet()
                    val input = JSONObject(request.body.readUtf8())
                    assertEquals("refresh", input.getString("refresh_token"))
                    reply(200, """{"access_token":"fresh","refresh_token":"rotated"}""")
                }
                else -> error(request.path.orEmpty())
            }
        }) { base ->
            val client = DriveClient(session(base)) { saves.incrementAndGet() }
            val callers = Executors.newFixedThreadPool(2)
            try {
                val tasks = List(2) { callers.submit(Callable { client.listFiles() }) }
                for (task in tasks) assertTrue(task.get(10, TimeUnit.SECONDS).isEmpty())
                assertEquals(1, refreshes.get())
                assertEquals(1, saves.get())
                assertEquals("rotated", client.session.refreshToken)
            } finally {
                callers.shutdownNow()
            }
        }
    }

    @Test fun interruptedUploadRemovesPendingRecord() {
        val deletes = AtomicInteger()
        withServer({ request ->
            when (request.method to request.path) {
                "POST" to "/api/files" -> reply(200, """{"id":"pending"}""")
                "DELETE" to "/api/files/pending" -> {
                    deletes.incrementAndGet()
                    reply(200, "{}")
                }
                else -> error(request.path.orEmpty())
            }
        }) { base ->
            val client = DriveClient(session(base)) {}
            val sample = File.createTempFile("upload", ".jpg")
            try {
                sample.writeText("sample")
                // The second cancellation check runs after the pending record has been created.
                var callbacks = 0
                try {
                    client.upload(null, sample, "image/jpeg") {
                        if (++callbacks == 2) throw IOException("sync stopped")
                    }
                    fail("upload must be interrupted")
                } catch (e: IOException) {
                    assertEquals("sync stopped", e.message)
                }
                assertEquals(1, deletes.get())
            } finally {
                sample.delete()
            }
        }
    }

    @Test fun staleListingDoesNotDeleteAnUploadWhoseFinalizeResponseWasLost() {
        val finalizing = CountDownLatch(1)
        val listingStarted = CountDownLatch(1)
        val uploadFinished = CountDownLatch(1)
        val deletes = AtomicInteger()
        withServer({ request ->
            when (request.method to request.path) {
                "POST" to "/api/files" -> reply(200, """{"id":"f"}""")
                "PUT" to "/api/files/f/manifest", "PUT" to "/api/files/f/chunks/0" -> reply(200, "{}")
                "POST" to "/api/files/f/finalize" -> {
                    finalizing.countDown()
                    assertTrue(listingStarted.await(5, TimeUnit.SECONDS))
                    reply(503, "{}")
                }
                "GET" to "/api/files" -> {
                    listingStarted.countDown()
                    assertTrue(uploadFinished.await(5, TimeUnit.SECONDS))
                    reply(200, """{"files":[{"id":"f","status":"uploading"}]}""")
                }
                "DELETE" to "/api/files/f" -> { deletes.incrementAndGet(); reply(200, "{}") }
                else -> error("Unexpected request: ${request.path}")
            }
        }) { base ->
            val client = DriveClient(session(base)) {}
            val pool = Executors.newSingleThreadExecutor()
            try {
                val attempt = pool.submit(Callable {
                    try {
                        client.createTextFile(null, "document.txt", "hello")
                        fail("Expected a lost finalize response")
                    } catch (e: StatusException) {
                        assertEquals(503, e.status)
                    } finally {
                        uploadFinished.countDown()
                    }
                })
                assertTrue(finalizing.await(5, TimeUnit.SECONDS))
                assertTrue(client.listFiles().isEmpty())
                attempt.get(5, TimeUnit.SECONDS)
                assertEquals(0, deletes.get())
                assertEquals(setOf("f"), client.session.pendingUploads)
            } finally {
                pool.shutdownNow()
            }
        }
    }

    private fun JSONObject.sealed(name: String, key: ByteArray, plain: ByteArray): JSONObject {
        val enc = WireCrypto.seal(key, plain)
        return put(name, WireCrypto.b64(enc.bytes)).put(name + "_nonce", WireCrypto.b64(enc.iv))
    }

    @Test fun restoredSessionCleansOnlyItsOwnIncompleteUploads() {
        val key = WireCrypto.random(32)
        val manifest = JSONObject().put("name", "finished.txt").put("size", 3)
            .put("iv_base", WireCrypto.b64(WireCrypto.random(12))).put("content_id", "restored")
            .put("plaintext_sha256", "a".repeat(64))
        val ready = JSONObject().put("id", "finished").put("status", "ready").put("chunk_count", 1)
            .sealed("encrypted_file_key", master, key)
            .sealed("encrypted_manifest", key, WireCrypto.pad(manifest.toString().toByteArray(), 256))
        val rows = JSONArray().put(ready)
            .put(JSONObject().put("id", "interrupted").put("status", "pending"))
            .put(JSONObject().put("id", "another-device").put("status", "pending"))
        val deletes = AtomicInteger()
        withServer({ request ->
            when (request.method to request.path) {
                "GET" to "/api/files" -> reply(200, JSONObject().put("files", rows).toString())
                "DELETE" to "/api/files/interrupted" -> {
                    deletes.incrementAndGet()
                    reply(200, "{}")
                }
                else -> error("Unexpected operation " + request.path.orEmpty())
            }
        }) { base ->
            val restored = session(base).withPending(setOf("finished", "interrupted", "already-removed"))
            val client = DriveClient(restored) {}
            assertEquals(listOf("finished"), client.listFiles().map { it.id })
            assertTrue(client.session.pendingUploads.isEmpty())
            client.listFiles()
            assertEquals(1, deletes.get())
        }
    }

    @Test fun nestedDirectoryUsesParentKeyForKeyWrapAndMasterForParentPointer() {
        val top = WireCrypto.random(32)
        val nested = WireCrypto.random(32)
        val topRow = JSONObject().put("id", "a")
            .sealed("encrypted_folder_key", master, top)
            .sealed("encrypted_name", top, WireCrypto.pad("Photos".toByteArray(), 32))
        val nestedRow = JSONObject().put("id", "b")
            .sealed("encrypted_parent_id", master, "a".toByteArray())
            .sealed("encrypted_folder_key", top, nested)
            .sealed("encrypted_name", nested, WireCrypto.pad("秋天".toByteArray(), 32))
        val upload = AtomicReference<JSONObject>()
        withServer({ request ->
            when (request.method to request.path) {
                "GET" to "/api/folders" -> reply(200,
                    JSONObject().put("folders", JSONArray().put(nestedRow).put(topRow)).toString())
                "POST" to "/api/files" -> {
                    upload.set(JSONObject(request.body.readUtf8()))
                    reply(200, """{"id":"f"}""")
                }
                "PUT" to "/api/files/f/chunks/0", "PUT" to "/api/files/f/manifest",
                "POST" to "/api/files/f/finalize" -> reply(200, "{}")
                else -> error(request.path.orEmpty())
            }
        }) { base ->
            val client = DriveClient(session(base)) {}
            assertEquals(listOf(CloudFolder("a", null, "Photos"), CloudFolder("b", "a", "秋天")), client.listFolders())
            val sample = File.createTempFile("android", ".jpeg")
            try {
                sample.writeBytes(byteArrayOf(3, 2, 1))
                assertEquals("b", client.upload("b", sample, "image/jpeg") {}.parentId)
                val wire = upload.get()
                assertNotNull(wire)
                fun unwrap(name: String, key: ByteArray) = WireCrypto.open(key,
                    WireCrypto.unb64(wire.getString(name)), WireCrypto.unb64(wire.getString(name + "_nonce")))
                assertArrayEquals("b".toByteArray(), unwrap("encrypted_parent_id", master))
                assertEquals(32, unwrap("encrypted_file_key", nested).size)
            } finally {
                sample.delete()
            }
        }
    }
}
