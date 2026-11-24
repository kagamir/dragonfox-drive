package dev.dragonfox.drive.ui

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.dragonfox.drive.R
import dev.dragonfox.drive.protocol.CloudFolder
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.DriveSession
import dev.dragonfox.drive.protocol.StatusException
import dev.dragonfox.drive.sync.SyncEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class DriveModel(private val app: Application) : AndroidViewModel(app) {
    private val vault = SessionVault(app)
    private val sessionLock = Any()
    private var generation = 0L
    private var visible = false
    private var client: DriveClient? = null
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

    suspend fun refreshFolders() {
        val api = client ?: return
        try {
            val items = withContext(Dispatchers.IO) { api.listFolders() }
            if (client === api) cloudFolders = items
        } catch (e: StatusException) {
            if (client === api && e.status == 401) signOut(expired = true)
            throw e
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
        engine?.close()
        engine = null
        client = null
        account = null
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
        engine?.close()
        super.onCleared()
    }
}
