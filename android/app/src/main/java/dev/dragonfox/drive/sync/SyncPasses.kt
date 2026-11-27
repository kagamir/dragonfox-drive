package dev.dragonfox.drive.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Called on Main. A foreground service or an active system job owns each pass. */
internal class SyncPasses(
    private val scope: CoroutineScope,
    private val beginForeground: (cancel: () -> Unit) -> AutoCloseable?,
    private val perform: suspend (SyncConfig) -> Boolean,
) {
    private class Pass(val config: SyncConfig, val task: Deferred<Boolean>) {
        var foreground = false
        var scheduledOwners = 0
    }

    private var current: Pass? = null

    fun cancelUnless(config: SyncConfig?) {
        current?.takeIf { it.config != config }?.task?.cancel()
    }

    suspend fun run(config: SyncConfig, foreground: Boolean, eligible: () -> Boolean): Boolean {
        // A cancelled pass can still be unwinding a blocking read or upload.
        // Wait for that work before starting a new pass over the same files.
        while (true) {
            if (!eligible()) return false
            val previous = current ?: break
            if (previous.task.isCompleted) break
            if (previous.config == config && !previous.task.isCancelled) break
            previous.task.cancelAndJoin()
        }
        val pass = current?.takeUnless { it.task.isCompleted }
            ?: Pass(config, scope.async(start = CoroutineStart.LAZY) { perform(config) }).also { current = it }
        if (foreground && !pass.foreground) {
            val lease = beginForeground { pass.task.cancel() }
            if (lease != null) {
                pass.foreground = true
                pass.task.invokeOnCompletion { lease.close() }
            } else if (pass.scheduledOwners == 0) {
                pass.task.cancel()
                return false
            }
        }
        if (!foreground) pass.scheduledOwners++
        try {
            return pass.task.await()
        } catch (e: CancellationException) {
            currentCoroutineContext().ensureActive() // Propagate cancellation of the caller.
            return false // A config/network change or service timeout interrupted the pass.
        } finally {
            if (!foreground) {
                pass.scheduledOwners--
                if (pass.scheduledOwners == 0 && !pass.foreground) pass.task.cancel()
            }
        }
    }
}
