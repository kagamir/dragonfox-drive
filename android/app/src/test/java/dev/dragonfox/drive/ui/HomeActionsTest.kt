package dev.dragonfox.drive.ui

import dev.dragonfox.drive.protocol.CloudFolder
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class HomeActionsTest {
    @Test fun moveOmitsSelectedTreesAndKeepsSiblingsAndAncestorsAvailable() {
        val tree = listOf(CloudFolder("parent", null, "P"), CloudFolder("picked", "parent", "Same"),
            CloudFolder("sibling", "parent", "Same"), CloudFolder("leaf", "picked", "nested"),
            CloudFolder("grandchild", "leaf", "more"))
        val chosen = listOf(HomeItem("picked", true, "Same"), HomeItem("sibling", false, "doc"))
        assertEquals(setOf("picked", "leaf", "grandchild"), blockedDestinations(tree, chosen))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun leavingHomeDoesNotResubmitOrLoseThePendingResult() = runTest {
        val submissions = HomeSubmissions(this)
        val finished = CompletableDeferred<Unit>()
        var count = 0
        submissions.submit { count++; finished.await() }
        val request = requireNotNull(submissions.pending)
        val observer = launch { request.await() }
        runCurrent()
        observer.cancelAndJoin()
        submissions.submit { count++ }
        assertSame(request, submissions.pending)
        assertFalse(request.isCancelled)
        finished.complete(Unit)
        request.await()
        assertSame(request, submissions.pending)
        submissions.consume(request)
        assertNull(submissions.pending)
        assertEquals(1, count)
    }
}
