package dev.dragonfox.drive.gallery

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
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
                                val bitmap = decodeBytes(bytes, edge) ?: return@let null
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
                active()
                data.seek(0)
                val exif = parseExif { ExifInterface(data.fd) }
                data.seek(0)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFileDescriptor(data.fd, null, bounds)
                val metadata = metadata(exif, bounds.outWidth, bounds.outHeight)
                active()
                data.seek(0)
                val options = BitmapFactory.Options().apply {
                    inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, edge, heap / 64)
                }
                val image = BitmapFactory.decodeFileDescriptor(data.fd, null, options) ?: exif?.thumbnailBytes?.let { decodeBytes(it, edge) }
                return LoadedPhoto(image?.let { orient(it, exif) }, metadata)
            }
        } finally {
            tmp.delete()
        }
    }

    private fun decodeBytes(bytes: ByteArray, edge: Int): Bitmap? {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        opts.inJustDecodeBounds = false
        opts.inSampleSize = sampleSize(opts.outWidth, opts.outHeight, edge, heap / 64)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    }

    private fun parseExif(read: () -> ExifInterface): ExifInterface? = try {
        read()
    } catch (_: IOException) { null } catch (_: RuntimeException) { null }

    private fun orient(bitmap: Bitmap, exif: ExifInterface?): Bitmap {
        if (exif == null || (exif.rotationDegrees == 0 && !exif.isFlipped)) return bitmap
        val matrix = Matrix()
        if (exif.isFlipped) matrix.setScale(-1f, 1f)
        matrix.postRotate(exif.rotationDegrees.toFloat())
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also {
            if (it !== bitmap) bitmap.recycle()
        }
    }

    private fun metadata(e: ExifInterface?, width: Int?, height: Int?): PhotoExif {
        fun text(tag: String) = e?.getAttribute(tag)?.trim()?.takeIf { it.isNotEmpty() }
        fun number(tag: String) = e?.getAttributeDouble(tag, Double.NaN)?.takeIf { it.isFinite() && it > 0 }
        val location = e?.latLong
        return PhotoExif(
            width?.takeIf { it > 0 } ?: number(ExifInterface.TAG_PIXEL_X_DIMENSION)?.toInt(),
            height?.takeIf { it > 0 } ?: number(ExifInterface.TAG_PIXEL_Y_DIMENSION)?.toInt(),
            text(ExifInterface.TAG_MAKE), text(ExifInterface.TAG_MODEL), text(ExifInterface.TAG_LENS_MODEL),
            text(ExifInterface.TAG_DATETIME_ORIGINAL) ?: text(ExifInterface.TAG_DATETIME),
            number(ExifInterface.TAG_FOCAL_LENGTH), number(ExifInterface.TAG_F_NUMBER),
            number(ExifInterface.TAG_EXPOSURE_TIME), number(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY)?.toInt(),
            location?.getOrNull(0), location?.getOrNull(1),
        )
    }
}
