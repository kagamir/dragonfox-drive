package dev.dragonfox.drive.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.system.Os
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.StatusException
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import java.io.File

class SyncEngine(
    context: Context,
    private val client: DriveClient,
    accountScope: String,
    beginForegroundPass: (cancel: () -> Unit) -> AutoCloseable? = { AutoCloseable { } },
) : AutoCloseable {
    private val app = context.applicationContext
    private val storage = SyncStorage(app, accountScope)
    private val scanner = FolderScanner(app)
    private val manager = app.getSystemService(ConnectivityManager::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableConfig = MutableStateFlow(storage.load())
    private val state = MutableStateFlow(SyncStatus())
    private val visible = MutableStateFlow(false)
    private val capacity = MutableStateFlow(0)
    private val wake = Channel<Unit>(Channel.CONFLATED)
    val config = mutableConfig.asStateFlow()
    val status = state.asStateFlow()

    private val passes = SyncPasses(scope, beginForegroundPass) { cfg ->
        withContext(Dispatchers.IO) { performPass(cfg) }
    }

    private fun applyCapabilities(caps: NetworkCapabilities?) {
        val count = if (caps == null) 0 else uploadLimit(true,
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED), caps.linkUpstreamBandwidthKbps)
        capacity.value = count
        state.update { it.copy(online = count > 0, concurrency = count) }
    }

    private val callback = object : ConnectivityManager.NetworkCallback() {
        private var current: Network? = null
        override fun onAvailable(network: Network) { current = network }
        override fun onLost(network: Network) {
            if (current == network) {
                current = null
                applyCapabilities(null)
            }
        }
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            if (current == network) applyCapabilities(caps)
        }
    }

    init {
        applyCapabilities(manager.getNetworkCapabilities(manager.activeNetwork))
        manager.registerDefaultNetworkCallback(callback)
        val eligible = combine(config, capacity) { cfg, count -> cfg.scanSettings(count) }.distinctUntilChanged()
        scope.launch {
            eligible.collect { passes.cancelUnless(config.value.scanSettings(capacity.value)) }
        }
        scope.launch {
            combine(eligible, visible) { cfg, foreground -> cfg.takeIf { foreground } }
                .distinctUntilChanged().collectLatest { cfg ->
                    if (cfg == null) return@collectLatest
                    while (isActive && !state.value.sessionExpired) {
                        passes.run(cfg, foreground = true) {
                            visible.value && config.value.scanSettings(capacity.value) == cfg
                        }
                        awaitNextScan(config.map { it.intervalSeconds }.distinctUntilChanged(), wake.receiveAsFlow())
                    }
                }
        }
    }

    // The interval changes when to schedule another scan, not the scope of an active one.
    private fun SyncConfig.scanSettings(count: Int): SyncConfig? =
        takeIf { enabled && localFolders.isNotEmpty() && count > 0 }
            ?.copy(intervalSeconds = DEFAULT_SYNC_INTERVAL_SECONDS)

    /** One system-scheduled pass. A false result lets the scheduler back off and retry. */
    suspend fun runScheduled(): Boolean = withContext(Dispatchers.Main.immediate) {
        val cfg = config.value
        if (!cfg.enabled || cfg.localFolders.isEmpty() || state.value.sessionExpired) return@withContext true
        val settings = cfg.scanSettings(capacity.value) ?: return@withContext false
        passes.run(settings, foreground = false) { config.value.scanSettings(capacity.value) == settings }
    }

    private suspend fun performPass(cfg: SyncConfig): Boolean {
        state.update { it.copy(running = true, scanning = true, tasks = emptyList(),
            completed = 0, total = 0, errors = emptyList()) }
        return try {
            if (!FileAccess.granted(app)) {
                report("请授权访问全部文件后再同步")
                true
            } else {
                reconcile(cfg)
                state.value.errors.isEmpty()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            report(e.message ?: e.javaClass.simpleName)
            val expired = e is StatusException && e.status == 401
            if (expired) state.update { it.copy(sessionExpired = true) }
            expired
        } finally {
            state.update { it.copy(scanning = false, running = false, tasks = emptyList()) }
        }
    }

    fun configure(config: SyncConfig) {
        val copy = config.normalized()
        storage.save(copy)
        mutableConfig.value = copy
    }

    fun setVisible(value: Boolean) { visible.value = value }
    fun rescan() { wake.trySend(Unit) }

    private fun report(message: String) {
        state.update { it.copy(errors = (it.errors + message).takeLast(12)) }
    }

    private data class Pending(val file: File, val path: List<String>, val mime: String)

    private suspend fun reconcile(cfg: SyncConfig) {
        val job = currentCoroutineContext()
        val volumes = scanner.volumes()
        val roots = cfg.localFolders.map(::File)
        val index = CloudIndex(client.listFolders(), client.listFiles())
        check(index.containsFolder(cfg.remoteFolderId)) { "云端目标目录已被移除，请重新选择" }
        roots.filterNot { scanner.accessible(it, volumes) }.forEach { report("存储设备不可用：${it.path}") }
        val pending = mutableListOf<Pending>()
        val files = selectedFiles(cfg, volumes.map { it.dir }, { scanner.accessible(it, volumes) }, { job.ensureActive() }) {
            report("无法读取目录：${it.path}")
        }
        for (file in files) {
            val mime = scanner.mime(file)
            if (!cfg.mode.accepts(mime)) continue
            val path = remotePath(file.parentFile ?: continue, volumes) ?: continue
            val matches = index.candidates(cfg.remoteFolderId, path, file.name, file.length())
            try {
                if (matches.isNotEmpty()) {
                    val stat = Os.stat(file.path)
                    val revision = listOf(stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtim.tv_sec,
                        stat.st_mtim.tv_nsec, stat.st_ctim.tv_sec, stat.st_ctim.tv_nsec).joinToString(":")
                    val local = storage.cachedDigest("local:${file.path}", revision) { digest(file) { job.ensureActive() } }
                    if (matches.any { remote ->
                        val hash = remote.sha256 ?: storage.cachedDigest("remote:${remote.id}", remote.revision) {
                            client.contentSha256(remote) { job.ensureActive() }
                        }
                        local.equals(hash, ignoreCase = true)
                    }) continue
                }
                pending += Pending(file, path, mime)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is StatusException && e.status == 401) throw e
                report("${file.name}：${e.message}")
            }
        }
        state.update { it.copy(scanning = false, total = pending.size) }
        uploadWithCapacity(pending, capacity) { upload(cfg, index, it) }
    }

    private suspend fun upload(cfg: SyncConfig, index: CloudIndex, item: Pending) {
        val job = currentCoroutineContext()
        val file = item.file
        val task = UploadTask(file.path, 0, file.length())
        state.update { it.copy(tasks = it.tasks + task) }
        try {
            val parent = index.ensureFolder(cfg.remoteFolderId, item.path) { id, name ->
                job.ensureActive()
                client.createFolder(id, name)
            }
            job.ensureActive()
            client.upload(parent, file, item.mime) { bytes ->
                job.ensureActive()
                state.update { status -> status.copy(tasks = status.tasks.map {
                    if (it.path == task.path) it.copy(sent = bytes) else it
                }) }
            }
            state.update { it.copy(completed = it.completed + 1) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is StatusException && e.status == 401) throw e
            report("${file.name}：${e.message}")
        } finally {
            state.update { status -> status.copy(tasks = status.tasks.filterNot { it.path == file.path }) }
        }
    }

    override fun close() {
        manager.unregisterNetworkCallback(callback)
        scope.coroutineContext.job.invokeOnCompletion { storage.close() }
        scope.cancel()
    }
}
