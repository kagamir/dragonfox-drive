package dev.dragonfox.drive

import android.app.ActivityManager
import android.app.job.JobScheduler
import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.provider.MediaStore
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.background.ActiveTransferService
import dev.dragonfox.drive.background.BackgroundSyncJob
import dev.dragonfox.drive.background.TransferRuntime
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.sync.SyncConfig
import dev.dragonfox.drive.sync.SyncMode
import dev.dragonfox.drive.sync.SyncStorage
import dev.dragonfox.drive.transfer.TransferPhase
import dev.dragonfox.drive.ui.SessionVault
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BackgroundTransfersTest {
    @Test fun uploadsFinishAfterHomeAndScreenOffThenScheduledSyncFindsANewFile() = runBlocking {
        val server = InstrumentationRegistry.getArguments().getString("syncServer")
        assumeNotNull(server)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val id = UUID.randomUUID().toString().take(12)
        val password = UUID.randomUUID().toString()
        val api = DriveClient.register(requireNotNull(server), "bg_$id", password) {}
        val vault = SessionVault(context)
        val previous = vault.read()
        val source = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "df-bg-$id")
        val manualName = "manual-$id.txt"
        val manualBytes = "selected document".toByteArray()
        val resolver = context.contentResolver
        val document = requireNotNull(resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, manualName)
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
        }))
        val runtime = TransferRuntime.get(context)
        val gate = HeldUploads(server)
        try {
            assertTrue(source.mkdirs())
            // Chunk one cannot leave the app until chunk zero receives a response after screen-off.
            val first = File(source, "auto.bin").apply { writeBytes(ByteArray(4 * 1024 * 1024 + 17) { it.toByte() }) }
            requireNotNull(resolver.openOutputStream(document)).use { it.write(manualBytes) }
            MockWebServer().use { proxy ->
                proxy.dispatcher = gate
                proxy.start(InetAddress.getByName("127.0.0.1"), 0)
                val appSession = DriveClient.login("http://127.0.0.1:${proxy.port}", api.session.username, password) {}.session
                vault.save(appSession)
                val storage = SyncStorage(context, appSession.server + "\n" + appSession.userId)
                try {
                    storage.save(SyncConfig(setOf(source.path), null, SyncMode.ALL, true, intervalSeconds = 3600))
                } finally { storage.close() }
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    val account = withTimeout(30_000) {
                        runtime.current.filterNotNull().first { it.client.session.userId == appSession.userId }
                    }
                    try {
                        withContext(Dispatchers.Main) { account.manual.uploadFiles(null, listOf(document)) }
                        assertTrue("automatic and manual uploads reached their first encrypted chunk",
                            gate.arrived.await(45, TimeUnit.SECONDS))
                        await { hasTransferService(context) }
                        val stopped = CountDownLatch(1)
                        activity.onActivity {
                            it.lifecycle.addObserver(object : DefaultLifecycleObserver {
                                override fun onStop(owner: LifecycleOwner) { stopped.countDown() }
                            })
                        }
                        shell("input keyevent KEYCODE_HOME")
                        assertTrue("Home stopped the transfer Activity", stopped.await(10, TimeUnit.SECONDS))
                        shell("input keyevent KEYCODE_SLEEP")
                        await { !context.getSystemService(PowerManager::class.java).isInteractive }
                        assertTrue("active transfers still have a foreground service", hasTransferService(context))
                        gate.resume.countDown()
                        withTimeout(60_000) {
                            account.engine.status.first { !it.running }
                            val transfer = account.manual.state.first { it.phase != TransferPhase.RUNNING }
                            assertEquals(transfer.error, TransferPhase.DONE, transfer.phase)
                        }
                        assertEquals("second encrypted chunk sent with the screen off", 0L, gate.secondChunk.count)
                        api.listFolders()
                        val uploaded = api.listFiles().associateBy { it.name }
                        assertEquals(setOf(first.name, manualName), uploaded.keys)
                        for ((name, expected) in listOf(first.name to first.readBytes(), manualName to manualBytes)) {
                            val plain = ByteArrayOutputStream()
                            api.readFile(uploaded.getValue(name), {}) { plain.write(it); true }
                            assertArrayEquals(expected, plain.toByteArray())
                        }
                        await { !hasTransferService(context) }

                        // Force delivery of the registered periodic job without waiting an hour.
                        // The foreground pass finished before this new file existed.
                        val next = File(source, "later.txt").apply { writeText("background scan") }
                        val scheduler = context.getSystemService(JobScheduler::class.java)
                        assertNotNull(scheduler.getPendingJob(BackgroundSyncJob.ID))
                        val result = shell("cmd jobscheduler run -f ${context.packageName} ${BackgroundSyncJob.ID}")
                        assertTrue(result, result.contains("Running job", ignoreCase = true))
                        await {
                            api.listFolders()
                            api.listFiles().any { it.name == next.name }
                        }
                        val finalFiles = api.listFiles()
                        assertEquals(listOf(first.name, next.name, manualName).sorted(), finalFiles.map { it.name }.sorted())
                        uploaded.forEach { (name, prior) -> assertEquals(prior.id, finalFiles.single { it.name == name }.id) }
                        assertEquals(Lifecycle.State.CREATED, activity.state)
                    } finally {
                        gate.resume.countDown()
                        shell("input keyevent KEYCODE_WAKEUP")
                        shell("wm dismiss-keyguard")
                        withContext(Dispatchers.Main) { runtime.logout(account.client, expired = false) }
                    }
                }
            }
        } finally {
            gate.resume.countDown()
            source.deleteRecursively()
            resolver.delete(document, null, null)
            if (previous == null) vault.clear() else vault.save(previous)
            api.logout()
        }
    }

    @Suppress("DEPRECATION")
    private fun hasTransferService(context: Context) = context.getSystemService(ActivityManager::class.java)
        .getRunningServices(Int.MAX_VALUE).any { it.service.className == ActiveTransferService::class.java.name && it.foreground }

    private suspend fun await(check: () -> Boolean) = withTimeout(45_000) {
        while (!check()) delay(100)
    }

    private fun shell(command: String): String {
        val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
    }
}

/** Hold actual encrypted PUTs until the activity is stopped. Every response still comes from the Rust API. */
private class HeldUploads(private val server: String) : Dispatcher() {
    private val upstream = OkHttpClient()
    val arrived = CountDownLatch(2)
    val resume = CountDownLatch(1)
    val secondChunk = CountDownLatch(1)

    override fun dispatch(request: RecordedRequest): MockResponse {
        val method = requireNotNull(request.method)
        if (method == "PUT" && request.path?.endsWith("/chunks/0") == true) {
            arrived.countDown()
            if (!resume.await(55, TimeUnit.SECONDS)) return MockResponse().setResponseCode(504)
        }
        if (method == "PUT" && request.path?.endsWith("/chunks/1") == true) secondChunk.countDown()
        val body = if (method == "GET" || method == "HEAD") null else
            request.body.readByteArray().toRequestBody(request.getHeader("Content-Type")?.toMediaTypeOrNull())
        val forward = Request.Builder().url(server.trimEnd('/') + request.path).method(method, body)
        request.getHeader("Authorization")?.let { forward.header("Authorization", it) }
        return upstream.newCall(forward.build()).execute().use { response ->
            MockResponse().setResponseCode(response.code).setBody(Buffer().write(response.body!!.bytes()))
        }
    }
}
