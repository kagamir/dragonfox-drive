package dev.dragonfox.drive.background

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.net.NetworkCapabilities
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BackgroundSyncJobTest {
    @Test fun schedulingPreservesAccountIsolationAndAppliesAndroidsMinimumPeriod() {
        val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
        val scheduler = context.getSystemService(JobScheduler::class.java)
        val previous = scheduler.getPendingJob(BackgroundSyncJob.ID)
        try {
            val alice = "https://example.test\nalice"
            assertTrue(BackgroundSyncJob.update(context, alice, true, 45))
            val first = requireNotNull(scheduler.getPendingJob(BackgroundSyncJob.ID))
            assertTrue(first.isPeriodic && first.isPersisted)
            assertTrue(requireNotNull(first.requiredNetwork).hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
            assertEquals(ComponentName(context, BackgroundSyncJob::class.java), first.service)
            assertEquals(JobInfo.getMinPeriodMillis(), first.intervalMillis)
            val accountField = first.extras.keySet().single()
            assertEquals(BackgroundSyncJob.binding(alice), first.extras.getString(accountField))

            // Several short in-app intervals share the same background schedule.
            assertTrue(BackgroundSyncJob.update(context, alice, true, 5))
            assertEquals(first.intervalMillis, requireNotNull(scheduler.getPendingJob(BackgroundSyncJob.ID)).intervalMillis)

            val bob = "https://example.test\nbob"
            assertTrue(BackgroundSyncJob.update(context, bob, true, 7200))
            val changed = requireNotNull(scheduler.getPendingJob(BackgroundSyncJob.ID))
            assertEquals(7_200_000L, changed.intervalMillis)
            assertEquals(BackgroundSyncJob.binding(bob), changed.extras.getString(accountField))
            assertTrue(changed.extras.getString(accountField) != first.extras.getString(accountField))

            BackgroundSyncJob.update(context, bob, false, 7200)
            assertNull(scheduler.getPendingJob(BackgroundSyncJob.ID))
        } finally {
            BackgroundSyncJob.cancel(context)
            if (previous != null) scheduler.schedule(previous)
        }
    }
}
