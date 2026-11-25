package dev.dragonfox.drive.sync

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.file.attribute.FileTime
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MediaCreatedTimesDeviceTest {
    @Test fun ambiguousBirthResolvesAnIndexedImageThroughItsActualVolumeAndExactPath() {
        val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
        val resolver = context.contentResolver
        val images = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(MediaStore.MediaColumns.DISPLAY_NAME, "DragonFox's-${UUID.randomUUID()}.jpg")
            put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = requireNotNull(resolver.insert(images, values))
        try {
            val bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
            try {
                requireNotNull(resolver.openOutputStream(uri)).use { output ->
                    assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output))
                }
            } finally {
                bitmap.recycle()
            }
            resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            val (file, addedSeconds) = requireNotNull(resolver.query(uri,
                arrayOf(MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.DATE_ADDED), null, null, null)).use {
                assertTrue(it.moveToFirst())
                File(it.getString(0)) to it.getLong(1)
            }
            assertTrue(addedSeconds > 0)
            val unknown = File(file.parentFile, "unindexed-${UUID.randomUUID()}.jpg")
            val time = FileTime.fromMillis(321)
            val source = MediaCreatedTimes(context) { MediaFileTimes(time, time) }
            assertEquals(mapOf(file to addedSeconds * 1000, unknown to 321L), source.read(listOf(file, unknown)))
        } finally {
            resolver.delete(uri, null, null)
        }
    }
}
