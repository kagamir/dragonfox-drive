package dev.dragonfox.drive.gallery

import android.graphics.Bitmap
import android.graphics.Color
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class LocalMediaLoaderTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    @Test fun samplesAndOrientsLocalPhotoAndInvalidatesCachedFramesOnChange() = runBlocking {
        val file = File.createTempFile("local-photo", ".jpg", instrumentation.targetContext.cacheDir)
        try {
            fun writePhoto(width: Int, height: Int, color: Int) {
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(color)
                file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it)) }
                bitmap.recycle()
                ExifInterface(file).apply {
                    setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
                    setAttribute(ExifInterface.TAG_MODEL, "Local fixture")
                    saveAttributes()
                }
            }
            writePhoto(1024, 512, Color.GREEN)
            val thumb = requireNotNull(LocalMediaLoader.thumbnail(file))
            assertTrue(thumb.height in 1..384)
            assertEquals(thumb.width * 2, thumb.height)
            assertSame(thumb, LocalMediaLoader.thumbnail(file))
            val detail = LocalMediaLoader.photo(file)
            assertEquals("Local fixture", detail.exif.model)
            assertEquals(512, detail.bitmap!!.width)
            assertEquals(1024, detail.bitmap!!.height)

            writePhoto(200, 200, Color.RED)
            val changed = requireNotNull(LocalMediaLoader.thumbnail(file))
            assertNotSame(thumb, changed)
            assertEquals(changed.width, changed.height)
            assertTrue(Color.red(changed.getPixel(0, 0)) > 210)
        } finally { file.delete() }
    }

    @Test fun decodesActualLocalVideoFrameAndHandlesUnsupportedInput() = runBlocking {
        val file = File.createTempFile("local-video", ".mp4", instrumentation.targetContext.cacheDir)
        try {
            instrumentation.context.assets.open("local_album_frame.mp4").use { source ->
                file.outputStream().use { source.copyTo(it) }
            }
            val frame = requireNotNull(LocalMediaLoader.thumbnail(file))
            val readable = if (frame.config == Bitmap.Config.HARDWARE) frame.copy(Bitmap.Config.ARGB_8888, false) else frame
            val center = readable.getPixel(readable.width / 2, readable.height / 2)
            if (readable !== frame) readable.recycle()
            assertTrue(maxOf(frame.width, frame.height) <= 384)
            assertTrue("expected red encoded video content", Color.red(center) > 160 && Color.blue(center) < 70)
            assertTrue(frame.width > frame.height)
            assertSame(frame, LocalMediaLoader.thumbnail(file))
            file.writeText("not a video")
            assertNull(LocalMediaLoader.thumbnail(file))
        } finally { file.delete() }
    }
}
