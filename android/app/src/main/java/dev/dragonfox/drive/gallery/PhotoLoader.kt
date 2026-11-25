package dev.dragonfox.drive.gallery

import android.content.Context
import android.graphics.Bitmap
import android.util.LruCache
import androidx.exifinterface.media.ExifInterface
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.DriveClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

data class PhotoExif(
    val width: Int? = null, val height: Int? = null,
    val make: String? = null, val model: String? = null, val lens: String? = null, val dateTime: String? = null,
    val focalLengthMm: Double? = null, val aperture: Double? = null, val exposureSeconds: Double? = null,
    val iso: Int? = null, val latitude: Double? = null, val longitude: Double? = null,
)

data class LoadedPhoto(val bitmap: Bitmap?, val exif: PhotoExif)

/** One instance per signed-in account. No plaintext file or cache survives the load. */
class PhotoLoader internal constructor(
    context: Context,
    private val readChunks: (CloudFile, () -> Unit, (ByteArray) -> Boolean) -> Unit,
) {
    constructor(context: Context, client: DriveClient) : this(context, client::readFile)
    private val directory = context.applicationContext.cacheDir
    private val heap = Runtime.getRuntime().maxMemory()
    private val permits = Semaphore(2)
    private val largeThumbnail = Semaphore(1)
    private data class CacheKey(val id: String, val revision: String, val detail: Boolean)
    private val cache = object : LruCache<CacheKey, LoadedPhoto>(minOf(heap / 8, 32L * 1024 * 1024).toInt()) {
        override fun sizeOf(key: CacheKey, value: LoadedPhoto) = (value.bitmap?.allocationByteCount ?: 0) + 512
    }

    suspend fun load(file: CloudFile, detail: Boolean = false): LoadedPhoto = withContext(Dispatchers.IO) {
        val key = CacheKey(file.id, file.revision, detail)
        cache.get(key)?.let { return@withContext it }
        suspend fun fetch() = permits.withPermit {
            cache.get(key)?.let { return@withPermit it }
            val job = currentCoroutineContext()
            val result = decode(file, detail) { job.ensureActive() }
            job.ensureActive()
            cache.put(key, result)
            result
        }
        if (!detail && file.size > 16L * 1024 * 1024) largeThumbnail.withPermit { fetch() } else fetch()
    }

    fun clear() = cache.evictAll()

    private fun decode(file: CloudFile, detail: Boolean, active: () -> Unit): LoadedPhoto {
        val edge = if (detail) 2560 else 384
        val tmp = File.createTempFile("df-image-", ".tmp", directory)
        try {
            RandomAccessFile(tmp, "rw").use { data ->
                // Keep the inode only for the lifetime of this descriptor, even if Android kills the process.
                if (!tmp.delete()) throw IOException("Cannot allocate private image buffer")
                var first = true
                var embedded: LoadedPhoto? = null
                readChunks(file, active) { plain ->
                    if (first) {
                        first = false
                        if (!detail) {
                            // JPEG/RAW commonly keep a small JPEG thumbnail in the first encrypted chunk.
                            val exif = parseExif { ExifInterface(ByteArrayInputStream(plain)) }
                            embedded = exif?.thumbnailBytes?.let { bytes ->
                                val bitmap = decodeBytes(bytes, edge, heap / 64) ?: return@let null
                                LoadedPhoto(orient(bitmap, exif), metadata(exif, null, null))
                            }
                            // Beyond the thumbnail transfer budget, manual opening can still decode the original.
                            if (embedded == null && file.size > 256L * 1024 * 1024) {
                                embedded = LoadedPhoto(null, metadata(exif, null, null))
                            }
                        }
                        if (embedded == null && file.size > directory.usableSpace - 8L * 1024 * 1024) {
                            throw IOException("Insufficient temporary space to decode this image")
                        }
                    }
                    if (embedded == null) data.write(plain)
                    embedded == null
                }
                embedded?.let { return it }
                return decodePhoto(data, edge, heap / 64, active)
            }
        } finally {
            tmp.delete()
        }
    }

}
