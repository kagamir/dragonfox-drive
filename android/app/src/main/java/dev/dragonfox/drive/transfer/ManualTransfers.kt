package dev.dragonfox.drive.transfer

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.dragonfox.drive.R
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.CloudFolder
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.StatusException
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class TransferPhase { IDLE, RUNNING, FAILED, CANCELLED, DONE }

data class TransferState(
    val phase: TransferPhase = TransferPhase.IDLE,
    val path: String = "",
    val bytes: Long = 0,
    val size: Long? = null,
    val completed: Int = 0,
    val total: Int? = null,
    val error: String? = null,
    val downloading: Boolean = false,
)

private sealed interface TransferRequest {
    class Upload(val parentId: String?, val uris: List<Uri>, val tree: Uri?) : TransferRequest
    class Download(val file: CloudFile, val output: Uri) : TransferRequest

    /** Copy just the chosen URIs to the transfer service for the lifetime of its start command. */
    fun serviceGrants(): Intent {
        val access = when (this) {
            is Upload -> if (tree != null) Intent.FLAG_GRANT_PREFIX_URI_PERMISSION else 0
            is Download -> Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        }
        val selected = when (this) {
            is Upload -> tree?.let(::listOf) ?: uris
            is Download -> listOf(output)
        }
        val clip = ClipData.newRawUri(null, selected.first())
        for (index in 1 until selected.size) clip.addItem(ClipData.Item(selected[index]))
        return Intent().apply {
            clipData = clip
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or access
        }
    }
}

/** The signed-in transfer runtime owns this manager. Start, cancel and close on the main thread. */
class ManualTransfers(
    context: Context,
    private val client: DriveClient,
    private val scope: CoroutineScope,
    private val onChanged: suspend () -> Unit,
    private val onExpired: () -> Unit,
    private val beginTransfer: (grants: Intent, cancel: () -> Unit) -> AutoCloseable = { _, _ -> AutoCloseable {} },
) {
    private val app = context.applicationContext
    private val documents = SafDocuments(app.contentResolver)
    private val active = MutableStateFlow(TransferState())
    val state = active.asStateFlow()
    val accountKey = client.session.server + "\n" + client.session.userId
    private var request: TransferRequest? = null
    private var job: Job? = null
    private var closed = false
    val retryDownload: CloudFile? get() = (request as? TransferRequest.Download)?.file

    fun uploadFiles(parentId: String?, uris: List<Uri>) {
        if (uris.isNotEmpty()) start(TransferRequest.Upload(parentId, uris.distinct(), null))
    }

    fun uploadFolder(parentId: String?, tree: Uri) = start(TransferRequest.Upload(parentId, emptyList(), tree))
    fun download(file: CloudFile, output: Uri) = start(TransferRequest.Download(file, output))
    fun cancel() { job?.cancel() }
    fun retry() { (request as? TransferRequest.Upload)?.let(::start) }
    fun dismiss() {
        if (active.value.phase != TransferPhase.RUNNING) {
            request = null
            active.value = TransferState()
        }
    }

    fun close() {
        closed = true
        request = null
        cancel()
    }

    private fun start(task: TransferRequest) {
        if (closed || active.value.phase == TransferPhase.RUNNING) return
        request = task
        active.value = TransferState(phase = TransferPhase.RUNNING, downloading = task is TransferRequest.Download)
        job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            var phase = TransferPhase.DONE
            var downloadStarted = false
            var complete = false
            var failure: Exception? = null
            var lease: AutoCloseable? = null
            try {
                val transferJob = currentCoroutineContext().job
                // Reserve foreground execution while the system picker result is being delivered.
                lease = beginTransfer(task.serviceGrants()) { transferJob.cancel() }
                withContext(Dispatchers.IO) {
                    val context = currentCoroutineContext()
                    val checkActive = { context.ensureActive() }
                    when (task) {
                        is TransferRequest.Upload -> upload(task, checkActive)
                        is TransferRequest.Download -> {
                            downloadStarted = true
                            save(task, checkActive)
                        }
                    }
                    complete = true
                }
            } catch (_: CancellationException) {
                // withContext may be cancelled on its way back to Main after publishing the complete result.
                if (!complete) phase = TransferPhase.CANCELLED
            } catch (e: Exception) {
                failure = if (lease == null) IOException(app.getString(R.string.transfer_background_unavailable), e) else e
                phase = TransferPhase.FAILED
            } finally {
                if (task is TransferRequest.Download && !downloadStarted) {
                    withContext(NonCancellable) {
                        withContext(Dispatchers.IO) {
                            runCatching { if (documents.isEmpty(task.output)) documents.discardOutput(task.output) }
                        }
                    }
                }
                lease?.close()
                if (!closed) {
                    if (phase == TransferPhase.DONE) request = null
                    active.update { it.copy(phase = phase, error = failure?.localizedMessage) }
                    if ((failure as? StatusException)?.status == 401) onExpired()
                    else if (task is TransferRequest.Upload && lease != null) scope.launch {
                        // A cancelled batch may already have finalized files or created its directory.
                        try { onChanged() } catch (e: StatusException) { if (e.status == 401) onExpired() }
                        catch (e: CancellationException) { throw e }
                        catch (_: Exception) { /* The browser retains its normal refresh action. */ }
                    }
                }
            }
        }
    }

    private fun upload(task: TransferRequest.Upload, checkActive: () -> Unit) {
        val items = task.tree?.let { documents.tree(it, checkActive) } ?: task.uris.map {
            checkActive()
            ImportItem(documents.file(it), null)
        }
        active.update { it.copy(total = items.count { item -> !item.file.directory }) }
        checkActive()
        val folders = client.listFolders()
        if (task.parentId != null && folders.none { it.id == task.parentId }) throw IOException(app.getString(R.string.transfer_folder_missing))
        val remote = ImportTree(folders, client.listFiles())
        val destinations = mutableMapOf<ImportItem, String>()
        for (item in items) {
            checkActive()
            val parentId = item.parent?.let { destinations.getValue(it) } ?: task.parentId
            val file = item.file
            active.update { it.copy(path = item.path, bytes = 0, size = if (file.directory) null else file.size) }
            if (file.directory) {
                destinations[item] = remote.folder(parentId, file.name) { name ->
                    checkActive()
                    client.createFolder(parentId, name)
                }.id
                continue
            }
            withUploadSource(file.size, app.cacheDir, { documents.input(file.uri) }, checkActive) { source ->
                active.update { it.copy(size = source.size) }
                val hash by lazy {
                    val digest = MessageDigest.getInstance("SHA-256")
                    source.open().use { input -> input.forEachBlock(checkActive) { bytes, count -> digest.update(bytes, 0, count) } }
                    digest.hexDigest()
                }
                val name = remote.availableName(parentId, file.name, source.size) { candidate ->
                    checkActive()
                    val existing = candidate.sha256 ?: client.contentSha256(candidate, checkActive)
                    hash.equals(existing, ignoreCase = true)
                }
                if (name != null) {
                    checkActive()
                    remote.record(client.uploadStream(parentId, name, source.size, file.mime, source.open) { sent ->
                        checkActive()
                        active.update { it.copy(bytes = sent) }
                    })
                }
                active.update { it.copy(bytes = source.size, completed = it.completed + 1) }
            }
        }
    }

    private fun save(task: TransferRequest.Download, checkActive: () -> Unit) {
        val file = task.file
        active.update { it.copy(total = 1, path = file.name, size = file.size) }
        if (!documents.isEmpty(task.output)) throw IOException(app.getString(R.string.transfer_choose_empty))
        var writing = false
        var destinationChanged = false
        try {
            checkActive()
            client.listFolders()
            val current = client.listFiles().find { it.id == file.id && it.revision == file.revision }
                ?: throw IOException(app.getString(R.string.transfer_file_changed))
            withScratchFile(app.cacheDir) { temp ->
                val digest = MessageDigest.getInstance("SHA-256")
                client.readFile(current, checkActive) { bytes ->
                    temp.write(bytes)
                    digest.update(bytes)
                    active.update { it.copy(bytes = it.bytes + bytes.size) }
                    true
                }
                if (current.sha256 != null && !digest.hexDigest().equals(current.sha256, ignoreCase = true)) {
                    throw IOException(app.getString(R.string.transfer_digest_failed))
                }
                checkActive()
                destinationChanged = !documents.isEmpty(task.output)
                if (destinationChanged) throw IOException(app.getString(R.string.transfer_choose_empty))
                documents.output(task.output).use { out ->
                    writing = true
                    temp.reopen().forEachBlock(checkActive) { bytes, count -> out.write(bytes, 0, count) }
                }
            }
            active.update { it.copy(completed = 1) }
        } catch (e: Exception) {
            if (!destinationChanged && (writing || runCatching { documents.isEmpty(task.output) }.getOrDefault(false))) {
                documents.discardOutput(task.output)
            }
            throw e
        }
    }
}

/** A retry takes a fresh remote index so already-completed files and empty folders can be reused. */
internal class ImportTree(folders: List<CloudFolder>, files: List<CloudFile>) {
    private val dirs = folders.associateBy { it.parentId to it.name }.toMutableMap()
    private val documents = files.groupByTo(mutableMapOf()) { it.parentId to it.name }

    fun folder(parent: String?, name: String, create: (String) -> CloudFolder): CloudFolder {
        var index = 0
        while (true) {
            val candidate = if (index == 0) name else "$name ($index)"
            val key = parent to candidate
            dirs[key]?.let { return it }
            if (key !in documents) return create(candidate).also { dirs[key] = it }
            index++
        }
    }

    fun availableName(parent: String?, name: String, size: Long, sameContent: (CloudFile) -> Boolean): String? {
        var index = 0
        while (true) {
            val candidate = suffixed(name, index++)
            val key = parent to candidate
            val matches = documents[key].orEmpty()
            if (matches.any { it.size == size && sameContent(it) }) return null
            if (matches.isEmpty() && key !in dirs) return candidate
        }
    }

    fun record(file: CloudFile) { documents.getOrPut(file.parentId to file.name) { mutableListOf() }.add(file) }
}
