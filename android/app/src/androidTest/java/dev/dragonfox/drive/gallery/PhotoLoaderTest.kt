package dev.dragonfox.drive.gallery

import android.graphics.Bitmap
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.protocol.CloudFile
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class PhotoLoaderTest {
    @Test fun gridDecodesSeventeenMiBOriginalsWithoutEmbeddedThumbnails() = runBlocking {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        for ((format, mime) in listOf(Bitmap.CompressFormat.JPEG to "image/jpeg", Bitmap.CompressFormat.PNG to "image/png")) {
            val image = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888)
            val header = java.io.ByteArrayOutputStream().use { image.compress(format, 90, it); it.toByteArray() }
            image.recycle()
            val total = 17L * 1024 * 1024
            val chunk = ByteArray(64 * 1024)
            var sent = 0L
            val loader = PhotoLoader(app) { _, active, consume ->
                assertTrue(consume(header))
                sent = header.size.toLong()
                while (sent < total) {
                    active()
                    val n = minOf(total - sent, chunk.size.toLong()).toInt()
                    assertTrue(consume(if (n == chunk.size) chunk else chunk.copyOf(n)))
                    sent += n
                }
            }
            val file = CloudFile("photo", null, "picture", total, revision = "v1", mime = mime)
            val preview = loader.load(file)
            assertEquals(total, sent)
            assertEquals(320, preview.bitmap!!.width)
            assertEquals(240, preview.bitmap!!.height)
        }
    }

    @Test fun rendersRotatedJpegExtractsCameraSettingsAndCachesByRevision() = runBlocking {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        val jpeg = File.createTempFile("fixture", ".jpg", app.cacheDir)
        try {
            val source = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888)
            jpeg.outputStream().use { source.compress(Bitmap.CompressFormat.JPEG, 88, it) }
            source.recycle()
            ExifInterface(jpeg).apply {
                setAttribute(ExifInterface.TAG_MAKE, "Example")
                setAttribute(ExifInterface.TAG_MODEL, "Camera A")
                setAttribute(ExifInterface.TAG_F_NUMBER, "4/1")
                setAttribute(ExifInterface.TAG_EXPOSURE_TIME, "1/200")
                setAttribute(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, "400")
                setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
                saveAttributes()
            }
            val bytes = jpeg.readBytes()
            var requests = 0
            val loader = PhotoLoader(app) { _, active, consume -> requests++; active(); consume(bytes); Unit }
            val file = CloudFile("p", "f", "photo.jpg", jpeg.length(), revision = "v1", mime = "image/jpeg")
            val detail = loader.load(file, detail = true)
            assertEquals(480, detail.bitmap!!.width)
            assertEquals(640, detail.bitmap!!.height)
            assertEquals("Camera A", detail.exif.model)
            assertEquals(400, detail.exif.iso)
            assertEquals(.005, detail.exif.exposureSeconds!!, .00001)
            assertSame(detail, loader.load(file, detail = true))
            assertEquals(1, requests)
            val thumb = loader.load(file)
            assertTrue(thumb.bitmap!!.height <= 384)
            loader.load(file.copy(revision = "v2"), detail = true)
            assertEquals(3, requests)
            assertTrue(app.cacheDir.list().orEmpty().none { it.startsWith("df-image-") })
        } finally {
            jpeg.delete()
        }
    }
}
