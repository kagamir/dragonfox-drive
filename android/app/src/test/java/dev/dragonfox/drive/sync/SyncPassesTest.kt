package dev.dragonfox.drive.sync

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncPassesTest {
    private val config = SyncConfig(enabled = true, localFolders = setOf("/photos"))

    @Test fun leavingTheUiAndJoiningFromASystemJobPreserveTheActivePass() = runTest {
        val transfer = CompletableDeferred<Unit>()
        var scans = 0
        var leases = 0
        val passes = SyncPasses(backgroundScope, { leases++; AutoCloseable { leases-- } }) {
            scans++
            transfer.await()
            true
        }

        val screen = async { passes.run(config, true) { true } }
        testScheduler.runCurrent()
        val system = async { passes.run(config, false) { true } }
        testScheduler.runCurrent()
        screen.cancelAndJoin()
        assertEquals(1, scans)
        assertEquals(1, leases)
        assertFalse(system.isCompleted)

        transfer.complete(Unit)
        assertTrue(system.await())
        assertEquals(0, leases)
    }

    @Test fun stoppedSystemJobUnwindsBeforeAReplacementPassStarts() = runTest {
        val unwinding = CompletableDeferred<Unit>()
        val cleaned = CompletableDeferred<Unit>()
        var scans = 0
        val passes = SyncPasses(backgroundScope, { null }) {
            if (++scans == 1) {
                try { awaitCancellation() }
                finally {
                    withContext(NonCancellable) {
                        unwinding.complete(Unit)
                        cleaned.await()
                    }
                }
            }
            true
        }
        val first = async { passes.run(config, false) { true } }
        testScheduler.runCurrent()
        first.cancelAndJoin()
        unwinding.await()
        val replacement = async { passes.run(config, false) { true } }
        testScheduler.runCurrent()
        assertEquals(1, scans)
        cleaned.complete(Unit)
        assertTrue(replacement.await())
        assertEquals(2, scans)
    }

    @Test fun reconfigurationAndForegroundServiceTimeoutCancelAndReleaseExactlyOnce() = runTest {
        var cancelService: (() -> Unit)? = null
        var released = 0
        val passes = SyncPasses(backgroundScope, { cancel ->
            cancelService = cancel
            AutoCloseable { released++ }
        }) { awaitCancellation() }

        val first = async { passes.run(config, true) { true } }
        testScheduler.runCurrent()
        passes.cancelUnless(config.copy(remoteFolderId = "changed"))
        assertFalse(first.await())
        assertEquals(1, released)

        val second = async { passes.run(config, true) { true } }
        testScheduler.runCurrent()
        requireNotNull(cancelService).invoke()
        assertFalse(second.await())
        assertEquals(2, released)
    }

    @Test fun deniedServiceLeavesTheNextSlotAvailableForTheSystemJob() = runTest {
        var scans = 0
        val passes = SyncPasses(backgroundScope, { null }) { scans++; true }
        assertFalse(passes.run(config, true) { true })
        assertFalse(passes.run(config, false) { false })
        assertEquals(0, scans)
        assertTrue(passes.run(config, false) { true })
        assertEquals(1, scans)
    }
}
