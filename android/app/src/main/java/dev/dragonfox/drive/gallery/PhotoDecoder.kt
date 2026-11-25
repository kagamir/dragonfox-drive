package dev.dragonfox.drive.gallery

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import java.io.IOException
import java.io.RandomAccessFile

/** Decode either a shared-storage file or a decrypted download using the same orientation and size limits. */
internal fun decodePhoto(data: RandomAccessFile, edge: Int, maxPixels: Long, active: () -> Unit): LoadedPhoto {
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
        inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, edge, maxPixels)
    }
    val image = BitmapFactory.decodeFileDescriptor(data.fd, null, options) ?: exif?.thumbnailBytes?.let { decodeBytes(it, edge, maxPixels) }
    return LoadedPhoto(image?.let { orient(it, exif) }, metadata)
}

internal fun decodeBytes(bytes: ByteArray, edge: Int, maxPixels: Long): Bitmap? {
    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    opts.inJustDecodeBounds = false
    opts.inSampleSize = sampleSize(opts.outWidth, opts.outHeight, edge, maxPixels)
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
}

internal fun parseExif(read: () -> ExifInterface): ExifInterface? = try {
    read()
} catch (_: IOException) { null } catch (_: RuntimeException) { null }

internal fun orient(bitmap: Bitmap, exif: ExifInterface?): Bitmap {
    if (exif == null || (exif.rotationDegrees == 0 && !exif.isFlipped)) return bitmap
    val matrix = Matrix()
    if (exif.isFlipped) matrix.setScale(-1f, 1f)
    matrix.postRotate(exif.rotationDegrees.toFloat())
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also {
        if (it !== bitmap) bitmap.recycle()
    }
}

internal fun metadata(e: ExifInterface?, width: Int?, height: Int?): PhotoExif {
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
