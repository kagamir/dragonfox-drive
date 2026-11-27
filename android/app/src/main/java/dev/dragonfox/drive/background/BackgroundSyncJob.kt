package dev.dragonfox.drive.background

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.PersistableBundle
import android.util.Log
import dev.dragonfox.drive.sync.hex
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** A network-constrained reconciliation that can wake a fresh app process. */
class BackgroundSyncJob : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var active: Job? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val account = params.extras.getString(ACCOUNT) ?: return false
        active?.cancel()
        active = scope.launch {
            val completed = try {
                TransferRuntime.get(applicationContext).runScheduled(account)
            } catch (e: CancellationException) {
                // A stopped OS job must not call jobFinished. If only the account's
                // pass was cancelled, complete this job and keep its periodic schedule.
                currentCoroutineContext().ensureActive()
                true
            } catch (e: Exception) {
                Log.w(TAG, "Scheduled sync could not finish", e)
                false
            }
            currentCoroutineContext().ensureActive()
            active = null
            jobFinished(params, !completed)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        active?.cancel()
        active = null
        return true
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        internal const val ID = 0xDF01
        private const val ACCOUNT = "account_binding"
        private const val TAG = "BackgroundSyncJob"

        internal fun binding(accountKey: String): String =
            MessageDigest.getInstance("SHA-256").digest(accountKey.toByteArray(Charsets.UTF_8)).hex()

        internal fun update(context: Context, accountKey: String, enabled: Boolean, intervalSeconds: Int): Boolean {
            if (!enabled) {
                cancel(context)
                return true
            }
            val scheduler = context.getSystemService(JobScheduler::class.java)
            val interval = (intervalSeconds * 1000L).coerceAtLeast(JobInfo.getMinPeriodMillis())
            val account = binding(accountKey)
            val existing = scheduler.getPendingJob(ID)
            if (existing != null && existing.intervalMillis == interval && existing.extras.getString(ACCOUNT) == account) {
                // Scheduling the same ID again can stop an active job and reset its window.
                return true
            }

            val extras = PersistableBundle().apply { putString(ACCOUNT, account) }
            val job = JobInfo.Builder(ID, ComponentName(context, BackgroundSyncJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .setPeriodic(interval, JobInfo.getMinFlexMillis())
                .setExtras(extras)
                .build()
            val scheduled = scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS
            if (!scheduled) Log.w(TAG, "Android declined the periodic sync schedule")
            return scheduled
        }

        internal fun cancel(context: Context) {
            context.getSystemService(JobScheduler::class.java).cancel(ID)
        }
    }
}
