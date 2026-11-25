package dev.dragonfox.drive.sync

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.merge

/** Restart only the idle timer when the interval changes; an upload already in progress is unaffected. */
internal suspend fun awaitNextScan(intervals: Flow<Int>, wake: Flow<Unit>) {
    val timer = channelFlow {
        intervals.collectLatest { seconds ->
            delay(seconds.coerceIn(SYNC_INTERVAL_RANGE) * 1000L)
            send(Unit)
        }
    }
    merge(timer, wake).first()
}
