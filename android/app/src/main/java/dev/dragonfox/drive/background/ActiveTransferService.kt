package dev.dragonfox.drive.background

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import dev.dragonfox.drive.MainActivity
import dev.dragonfox.drive.R

/** Keeps user-started work running through screen-off and Activity lifecycle changes. */
class ActiveTransferService : Service() {
    companion object {
        private const val CHANNEL = "active_transfers"
        private const val NOTIFICATION = 1501
        private const val LOCK_TIMEOUT_MS = 10 * 60_000L
        private val guard = Any()
        private val leases = mutableSetOf<Lease>()
        private const val GENERATION = "transfer_generation"
        private val uriFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        private var generation = 0L
        private var starting = false
        private var service: ActiveTransferService? = null

        /** Call while work is submitted from the foreground. A rejected start is reported to the caller. */
        fun acquire(
            context: Context,
            progress: () -> Pair<Int, Int>? = { null },
            grants: Intent? = null,
            onStopped: () -> Unit = {},
        ): AutoCloseable = synchronized(guard) {
            val first = service == null && !starting
            if (first || grants != null) {
                val app = context.applicationContext
                if (first) generation++
                val intent = Intent(app, ActiveTransferService::class.java).putExtra(GENERATION, generation)
                if (grants != null) {
                    intent.clipData = grants.clipData
                    intent.addFlags(grants.flags and uriFlags)
                }
                if (first) {
                    checkNotNull(app.startForegroundService(intent))
                    starting = true
                } else {
                    // SAF grants on a started service survive the originating Activity's destruction.
                    checkNotNull(app.startService(intent))
                }
            }
            Lease(progress, onStopped).also { leases.add(it) }
        }
    }

    private class Lease(val progress: () -> Pair<Int, Int>?, val onStopped: () -> Unit) : AutoCloseable {
        override fun close() {
            synchronized(guard) {
                if (leases.remove(this) && leases.isEmpty()) {
                    service?.let { active -> active.handler.post { active.stopIfIdle() } }
                }
            }
        }
    }

    private data class Progress(val count: Int, val completed: Long, val total: Long)

    private val handler = Handler(Looper.getMainLooper())
    private val notifications by lazy { getSystemService(NotificationManager::class.java) }
    private val wakeLock by lazy {
        getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DragonFoxDrive:transfer")
            .apply { setReferenceCounted(false) }
    }
    private var displayed: Progress? = null

    private val renewLock = object : Runnable {
        override fun run() {
            wakeLock.acquire(LOCK_TIMEOUT_MS)
            handler.postDelayed(this, LOCK_TIMEOUT_MS / 2)
        }
    }

    private val refreshNotification = object : Runnable {
        override fun run() {
            val progress = progressSnapshot()
            if (progress != displayed && progress.count > 0 && (Build.VERSION.SDK_INT < 33 ||
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)) {
                notifications.notify(NOTIFICATION, notification(progress))
                displayed = progress
            }
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        notifications.createNotificationChannel(NotificationChannel(
            CHANNEL, getString(R.string.bg_transfer_channel), NotificationManager.IMPORTANCE_LOW
        ).apply { setShowBadge(false) })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        synchronized(guard) {
            // A late grant delivery from the previous generation must not claim a new lease.
            // An orphaned start after process death has no leases: promote, then stop below.
            if (intent?.getLongExtra(GENERATION, -1L) != generation && leases.isNotEmpty()) {
                return START_NOT_STICKY
            }
            starting = false
            service = this
            val progress = progressSnapshot()
            try {
                // Even a request that completed before service creation must meet the promotion deadline.
                startForeground(NOTIFICATION, notification(progress), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                displayed = progress
            } catch (_: IllegalStateException) {
                interruptTransfers()
                return START_NOT_STICKY
            } catch (_: SecurityException) {
                interruptTransfers()
                return START_NOT_STICKY
            }
            if (leases.isEmpty()) stopIfIdle() else {
                handler.removeCallbacks(renewLock)
                handler.removeCallbacks(refreshNotification)
                renewLock.run()
                handler.postDelayed(refreshNotification, 1_000)
            }
        }
        return START_NOT_STICKY
    }

    private fun progressSnapshot(): Progress {
        val current = synchronized(guard) { leases.toList() }
        var completed = 0L
        var total = 0L
        for (lease in current) {
            val counts = lease.progress()
            if (counts == null || counts.second <= 0) return Progress(current.size, 0, 0)
            total += counts.second
            completed += counts.first.coerceIn(0, counts.second)
        }
        return Progress(current.size, completed, total)
    }

    private fun notification(progress: Progress): Notification {
        val destination = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val open = PendingIntent.getActivity(this, 0, destination, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val known = progress.total > 0
        val message = if (known) getString(R.string.bg_transfer_progress, progress.completed, progress.total)
            else getString(R.string.bg_transfer_open)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.df_sync)
            .setContentTitle(getString(R.string.bg_transfer_title))
            .setContentText(message)
            .setContentIntent(open)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setShowWhen(false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, if (known) (progress.completed * 100 / progress.total).toInt() else 0, !known)
            .build()
    }

    private fun stopIfIdle() {
        synchronized(guard) {
            if (service === this && leases.isEmpty()) {
                service = null
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                releaseResources()
            }
        }
    }

    private fun releaseResources() {
        handler.removeCallbacks(renewLock)
        handler.removeCallbacks(refreshNotification)
        if (wakeLock.isHeld) wakeLock.release()
    }

    private fun interruptTransfers() {
        val interrupted = synchronized(guard) {
            if (service !== this) return
            val active = leases.toList()
            leases.clear()
            stopIfIdle()
            active
        }
        interrupted.forEach { it.onStopped() }
    }

    override fun onTimeout(startId: Int, fgsType: Int) = interruptTransfers()

    override fun onDestroy() {
        interruptTransfers()
        releaseResources()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
