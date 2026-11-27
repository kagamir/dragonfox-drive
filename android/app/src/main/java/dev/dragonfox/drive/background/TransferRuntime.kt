package dev.dragonfox.drive.background

import android.content.Context
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.DriveSession
import dev.dragonfox.drive.sync.SyncEngine
import dev.dragonfox.drive.transfer.ManualTransfers
import dev.dragonfox.drive.ui.SessionVault
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal class AccountTransfers(
    val client: DriveClient,
    val engine: SyncEngine,
    val manual: ManualTransfers,
    val cloudChanges: MutableStateFlow<Long>,
    private val scope: CoroutineScope,
) {
    fun close() {
        manual.close()
        engine.close()
        scope.cancel()
    }
}

/** One client owns token rotation, the upload journal and transfers for both the UI and scheduled jobs. */
internal class TransferRuntime private constructor(private val app: Context) {
    companion object {
        @Volatile private var instance: TransferRuntime? = null

        fun get(context: Context): TransferRuntime = instance ?: synchronized(this) {
            instance ?: TransferRuntime(context.applicationContext).also { instance = it }
        }
    }

    private val vault = SessionVault(app)
    private val sessionLock = Any()
    private val lifecycle = Mutex()
    private var generation = 0L
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val visibleOwners = mutableSetOf<Any>()
    private val session = MutableStateFlow<AccountTransfers?>(null)
    val current = session.asStateFlow()
    var expired = false
        private set

    private fun writer(id: Long): (DriveSession) -> Unit = { updated ->
        synchronized(sessionLock) { if (generation == id) vault.save(updated) }
    }

    // Called on Main. Invalidate old writers before cancelling any in-flight uploads.
    private fun retire() {
        synchronized(sessionLock) { generation++ }
        val old = session.value
        session.value = null
        old?.close()
    }

    fun setVisible(owner: Any, visible: Boolean) {
        if (visible) visibleOwners.add(owner) else visibleOwners.remove(owner)
        session.value?.engine?.setVisible(visibleOwners.isNotEmpty())
    }

    private fun attach(client: DriveClient): AccountTransfers {
        val accountScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val accountKey = client.session.server + "\n" + client.session.userId
        val changes = MutableStateFlow(0L)
        lateinit var engine: SyncEngine
        engine = SyncEngine(app, client, accountKey) { cancel ->
            try {
                ActiveTransferService.acquire(app, progress = {
                    engine.status.value.let { it.completed to it.total }
                }, onStopped = cancel)
            } catch (_: IllegalStateException) {
                // The activity may have just lost foreground eligibility. The system job can retry.
                null
            } catch (_: SecurityException) {
                null
            }
        }
        lateinit var manual: ManualTransfers
        manual = ManualTransfers(app, client, accountScope, onChanged = { changes.update { it + 1 } },
            onExpired = { signOut(client, expired = true) }, beginTransfer = { grants, cancel ->
                ActiveTransferService.acquire(app, progress = {
                    manual.state.value.let { state -> state.total?.let { state.completed to it } }
                }, grants = grants, onStopped = cancel)
            })
        val binding = AccountTransfers(client, engine, manual, changes, accountScope)
        session.value = binding
        expired = false
        engine.setVisible(visibleOwners.isNotEmpty())
        accountScope.launch {
            engine.config.collect { cfg ->
                BackgroundSyncJob.update(app, accountKey, cfg.enabled && cfg.localFolders.isNotEmpty(), cfg.intervalSeconds)
            }
        }
        accountScope.launch {
            engine.status.first { it.sessionExpired }
            signOut(client, expired = true)
        }
        return binding
    }

    suspend fun restore(forUi: Boolean = false): AccountTransfers? = withContext(Dispatchers.Main.immediate) {
        lifecycle.withLock {
            val active = session.value
            if (active != null && !forUi) return@withLock active
            val saved = withContext(Dispatchers.IO) { synchronized(sessionLock) { vault.read() } }
            if (saved != null && active?.client?.session?.let {
                    it.server == saved.server && it.userId == saved.userId && it.masterKey == saved.masterKey
                } == true) return@withLock active
            retire()
            if (saved == null) {
                BackgroundSyncJob.cancel(app)
                null
            } else attach(DriveClient(saved, writer(generation)))
        }
    }

    suspend fun authenticate(server: String, username: String, password: String, register: Boolean) =
        withContext(Dispatchers.Main.immediate) {
            lifecycle.withLock {
                check(session.value == null)
                val save = writer(generation)
                val client = withContext(Dispatchers.IO) {
                    if (register) DriveClient.register(server, username, password, save)
                    else DriveClient.login(server, username, password, save)
                }
                attach(client)
            }
        }

    fun signOut(client: DriveClient, expired: Boolean) {
        scope.launch(start = CoroutineStart.UNDISPATCHED) { logout(client, expired) }
    }

    suspend fun logout(client: DriveClient, expired: Boolean) = withContext(Dispatchers.Main.immediate) {
        lifecycle.withLock {
            if (session.value?.client !== client) return@withContext
            this@TransferRuntime.expired = expired
            retire()
            BackgroundSyncJob.cancel(app)
            withContext(NonCancellable + Dispatchers.IO) { synchronized(sessionLock) { vault.clear() } }
        }
        if (!expired) withContext(Dispatchers.IO) { runCatching { client.logout() } }
        Unit
    }

    suspend fun runScheduled(accountBinding: String): Boolean {
        val active = restore() ?: return true
        if (BackgroundSyncJob.binding(active.manual.accountKey) != accountBinding) return true
        return active.engine.runScheduled()
    }
}
