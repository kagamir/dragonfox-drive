package dev.dragonfox.drive.sync

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicInteger

internal suspend fun <T> uploadWithCapacity(
    pending: List<T>, capacity: StateFlow<Int>, upload: suspend (T) -> Unit,
) = coroutineScope {
    val next = AtomicInteger()
    val exhausted = MutableStateFlow(pending.isEmpty())
    repeat(minOf(3, pending.size)) { slot ->
        launch {
            while (!exhausted.value) {
                combine(capacity, exhausted) { limit, done -> done || slot < limit }.first { it }
                if (exhausted.value) break
                val i = next.getAndIncrement()
                if (i >= pending.lastIndex) exhausted.value = true
                if (i < pending.size) upload(pending[i])
            }
        }
    }
}
