package dev.dragonfox.drive.gallery

import android.graphics.Bitmap
import android.media.ThumbnailUtils
import android.os.CancellationSignal
import android.util.LruCache
import android.util.Size
import android.webkit.MimeTypeMap
import dev.dragonfox.drive.sync.fileMime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal fun isLocalVideo(file: File): Boolean =
    fileMime(file) { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }.startsWith("video/")

/** Shared RAM-only thumbnail cache. Full-size previews stay owned by the open detail screen. */
internal object LocalMediaLoader {
    private const val thumbEdge = 384
    private val heap = Runtime.getRuntime().maxMemory()
    private val slots = Semaphore(2)
    private data class Version(val path: String, val modified: FileTime, val size: Long, val fileKey: Any?)
    private data class Thumbnail(val bitmap: Bitmap?)
    private val cache = object : LruCache<Version, Thumbnail>(minOf(heap / 16, 16L * 1024 * 1024).toInt()) {
        override fun sizeOf(key: Version, value: Thumbnail) = (value.bitmap?.allocationByteCount ?: 0) + 256
    }

    suspend fun thumbnail(file: File): Bitmap? = withContext(Dispatchers.IO) {
        val attrs = Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        if (!attrs.isRegularFile || !file.canRead()) return@withContext null
        val key = Version(file.absolutePath, attrs.lastModifiedTime(), attrs.size(), attrs.fileKey())
        cache.get(key)?.let { return@withContext it.bitmap }
        slots.withPermit {
            cache.get(key)?.let { return@withPermit it.bitmap }
            val bitmap = if (isLocalVideo(file)) videoFrame(file) else readImage(file, thumbEdge).bitmap
            currentCoroutineContext().ensureActive()
            cache.put(key, Thumbnail(bitmap))
            bitmap
        }
    }

    suspend fun photo(file: File): LoadedPhoto = withContext(Dispatchers.IO) {
        slots.withPermit { readImage(file, 2560) }
    }

    private suspend fun readImage(file: File, edge: Int): LoadedPhoto {
        val job = currentCoroutineContext()
        job.ensureActive()
        return RandomAccessFile(file, "r").use { data ->
            decodePhoto(data, edge, heap / 64) { job.ensureActive() }
        }
    }

    private suspend fun videoFrame(file: File): Bitmap? = suspendCancellableCoroutine { awaiting ->
        val cancel = CancellationSignal()
        awaiting.invokeOnCancellation { cancel.cancel() }
        try {
            val frame = ThumbnailUtils.createVideoThumbnail(file, Size(thumbEdge, thumbEdge), cancel)
            // A provider may fit the *shorter* side to the requested square.
            // Bound panoramic frames on their longest side before caching them.
            val longest = maxOf(frame.width, frame.height)
            val thumbnail = if (longest <= thumbEdge) frame else {
                val w = maxOf(1, (frame.width.toLong() * thumbEdge / longest).toInt())
                val h = maxOf(1, (frame.height.toLong() * thumbEdge / longest).toInt())
                Bitmap.createScaledBitmap(frame, w, h, true).also { frame.recycle() }
            }
            awaiting.resume(thumbnail)
        } catch (_: IOException) {
            awaiting.resume(null)
        } catch (failure: Exception) {
            if (awaiting.isActive) awaiting.resumeWithException(failure)
        }
    }
}
