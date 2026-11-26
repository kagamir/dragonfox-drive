package dev.dragonfox.drive.ui

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.PhotoLoader
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.FolderType
import dev.dragonfox.drive.protocol.CloudFolder
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.DriveSession
import dev.dragonfox.drive.protocol.StatusException
import dev.dragonfox.drive.sync.SyncEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import dev.dragonfox.drive.transfer.ManualTransfers
import kotlinx.coroutines.async
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class DriveModel(private val app: Application) : AndroidViewModel(app), HomeManagement {
    private val preferences = app.getSharedPreferences("appearance", Context.MODE_PRIVATE)
    var theme by mutableStateOf(ThemeChoice.entries.find { it.name == preferences.getString("theme", null) } ?: ThemeChoice.SYSTEM)
        private set

    fun selectTheme(choice: ThemeChoice) {
        preferences.edit().putString("theme", choice.name).apply()
        theme = choice
    }

    private val vault = SessionVault(app)
    private val sessionLock = Any()
    private var generation = 0L
    private var visible = false
    @Volatile private var client: DriveClient? = null
    private var homeScope: CoroutineScope? = null
    private val cloudChanges = Mutex()
    val homeTextDraft = HomeTextDraft()
    val homeShareDraft = HomeShareDraft()
    override val submissions = HomeSubmissions(viewModelScope)
    override var newTextBody by mutableStateOf("")
    var manualTransfers by mutableStateOf<ManualTransfers?>(null)
        private set
    var homeRefreshNotice by mutableStateOf<String?>(null)
        private set
    fun dismissHomeNotice() { homeRefreshNotice = null }
    private var expiryObserver: Job? = null
    var engine by mutableStateOf<SyncEngine?>(null)
        private set
    var account by mutableStateOf<DriveSession?>(null)
        private set
    var restoring by mutableStateOf(true)
        private set
    var busy by mutableStateOf(false)
        private set
    var authError by mutableStateOf<String?>(null)
        private set
    var photoLoader by mutableStateOf<PhotoLoader?>(null)
        private set
    var cloudFiles by mutableStateOf<List<CloudFile>>(emptyList())
        private set
    var cloudFolders by mutableStateOf<List<CloudFolder>>(emptyList())
        private set

    init {
        viewModelScope.launch {
            try {
                val saved = withContext(Dispatchers.IO) { synchronized(sessionLock) { vault.read() } }
                if (saved != null) attach(DriveClient(saved, writer(generation)))
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                withContext(Dispatchers.IO) { synchronized(sessionLock) { vault.clear() } }
                authError = app.getString(R.string.df_unlock_failed)
            } finally { restoring = false }
        }
    }

    private fun writer(id: Long): (DriveSession) -> Unit = { session ->
        synchronized(sessionLock) { if (id == generation) vault.save(session) }
    }

    private fun attach(api: DriveClient) {
        client = api
        val scope = CoroutineScope(viewModelScope.coroutineContext + SupervisorJob(viewModelScope.coroutineContext.job))
        homeScope = scope
        manualTransfers = ManualTransfers(app, api, scope,
            onChanged = {
                if (client === api) {
                    try { refreshDrive() }
                    catch (e: CancellationException) { throw e }
                    catch (_: Exception) {
                        if (client === api) homeRefreshNotice = app.getString(R.string.df_home_refresh_failed)
                    }
                }
            },
            onExpired = { if (client === api) signOut(expired = true) })
        photoLoader = PhotoLoader(app, api)
        val session = api.session
        account = session
        val active = SyncEngine(app, api, session.server + "\n" + session.userId)
        engine = active
        active.setVisible(visible)
        expiryObserver = viewModelScope.launch {
            active.status.first { it.sessionExpired }
            if (engine === active) signOut(expired = true)
        }
    }

    fun clearAuthError() { authError = null }

    fun authenticate(server: String, user: String, password: String, register: Boolean) {
        if (busy) return
        busy = true
        authError = null
        val id = synchronized(sessionLock) { ++generation }
        viewModelScope.launch {
            try {
                val api = withContext(Dispatchers.IO) {
                    val save = writer(id)
                    if (register) DriveClient.register(server.trim(), user.trim(), password, save)
                        else DriveClient.login(server.trim(), user.trim(), password, save)
                }
                if (id == generation) attach(api)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                authError = when ((e as? StatusException)?.status) {
                    401 -> app.getString(R.string.df_bad_credentials)
                    403 -> app.getString(R.string.df_forbidden)
                    else -> e.localizedMessage ?: app.getString(R.string.df_request_failed)
                }
            } finally { busy = false }
        }
    }

    private fun currentApi(): DriveClient = client ?: throw CancellationException()

    private suspend fun <T> onServer(api: DriveClient, request: (DriveClient) -> T): T {
        if (client !== api) throw CancellationException()
        try {
            val result = withContext(Dispatchers.IO) { request(api) }
            if (client !== api) throw CancellationException()
            return result
        } catch (e: StatusException) {
            if (client === api && e.status == 401) signOut(expired = true)
            throw e
        }
    }

    suspend fun <T> homeRead(request: (DriveClient) -> T): T = onServer(currentApi(), request)

    private suspend fun reload(api: DriveClient) {
        val (folders, files) = onServer(api) { it.listFolders() to it.listFiles() }
        cloudFolders = folders
        cloudFiles = files
        homeRefreshNotice = null
    }

    suspend fun refreshFolders() {
        val api = currentApi()
        cloudChanges.withLock { cloudFolders = onServer(api, DriveClient::listFolders) }
    }

    suspend fun refreshDrive() {
        val api = currentApi()
        cloudChanges.withLock { reload(api) }
    }

    // Once submitted, finish and refresh even when the user rotates or leaves Home.
    // A failed refresh must not turn an already committed create into a retry.
    suspend fun <T> homeWrite(request: (DriveClient) -> T): T {
        val api = currentApi()
        val scope = homeScope ?: throw CancellationException()
        return scope.async {
            cloudChanges.withLock {
                try {
                    onServer(api, request)
                } finally {
                    if (client === api) {
                        try { reload(api) }
                        catch (e: CancellationException) { throw e }
                        catch (e: Exception) {
                            if (client === api) homeRefreshNotice = app.getString(R.string.df_home_refresh_failed)
                        }
                    }
                }
            }
        }.await()
    }

    suspend fun setFolderType(id: String, type: FolderType) = homeWrite { it.setFolderType(id, type) }

    override suspend fun createFolder(parentId: String?, name: String) {
        homeWrite { it.createFolder(parentId, name) }
    }

    override suspend fun createText(parentId: String?, name: String, content: String) {
        homeWrite { it.createTextFile(parentId, name, content) }
    }

    override suspend fun rename(item: HomeItem, name: String) {
        homeWrite { if (item.isFolder) it.renameFolder(item.id, name) else it.renameFile(item.id, name) }
    }

    override suspend fun move(items: List<HomeItem>, parentId: String?) = applyBatch(items) { api, item ->
        if (item.isFolder) api.moveFolder(item.id, parentId) else api.moveFile(item.id, parentId)
    }

    override suspend fun delete(items: List<HomeItem>) = applyBatch(items) { api, item ->
        if (item.isFolder) api.deleteFolder(item.id) else api.deleteFile(item.id)
    }

    private suspend fun applyBatch(items: List<HomeItem>, action: (DriveClient, HomeItem) -> Unit) {
        // Home selections contain siblings. Each selected subtree is one server operation.
        homeWrite { api ->
            val failures = linkedMapOf<HomeItem, String>()
            val selection = items.distinctBy(HomeItem::key)
            for (item in selection) {
                if (client !== api) throw CancellationException()
                try { action(api, item) }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) {
                    if (e is StatusException && e.status == 401) throw e
                    failures[item] = e.localizedMessage ?: app.getString(R.string.df_request_failed)
                }
            }
            if (failures.isNotEmpty()) {
                val first = failures.entries.first()
                throw HomeBatchException(failures.keys, app.getString(R.string.df_home_batch_failed,
                    selection.size - failures.size, selection.size, first.key.name, first.value))
            }
        }
    }

    fun setVisible(value: Boolean) {
        visible = value
        engine?.setVisible(value)
    }

    fun signOut(expired: Boolean = false) {
        val old = client ?: return
        synchronized(sessionLock) { generation++ }
        expiryObserver?.cancel()
        expiryObserver = null
        manualTransfers?.close()
        manualTransfers = null
        submissions.clear()
        homeTextDraft.clear()
        homeShareDraft.clear()
        newTextBody = ""
        homeRefreshNotice = null
        homeScope?.cancel()
        homeScope = null
        engine?.close()
        engine = null
        client = null
        account = null
        photoLoader?.clear()
        photoLoader = null
        cloudFiles = emptyList()
        cloudFolders = emptyList()
        busy = true
        authError = if (expired) app.getString(R.string.df_expired) else null
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { synchronized(sessionLock) { vault.clear() } }
            } finally { busy = false }
            if (!expired) withContext(Dispatchers.IO) { runCatching { old.logout() } }
        }
    }

    override fun onCleared() {
        manualTransfers?.close()
        submissions.clear()
        homeTextDraft.clear()
        homeShareDraft.clear()
        newTextBody = ""
        homeScope?.cancel()
        engine?.close()
        super.onCleared()
    }
}

internal class HomeBatchException(val remaining: Set<HomeItem>, message: String) : Exception(message)
