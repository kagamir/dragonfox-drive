package dev.dragonfox.drive.ui

import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.PhotoExif
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotoDetailsTest {
    @Test fun preservesCameraValuesAndFormatsCommonShutterSpeeds() {
        val rows = PhotoExif(model = "Test camera", exposureSeconds = 0.004, iso = 125,
            width = 4000, height = 3000).rows().toMap()
        assertEquals("Test camera", rows[R.string.df_camera_model])
        assertEquals("1/250 s", rows[R.string.df_camera_shutter])
        assertEquals("125", rows[R.string.df_camera_iso])
        assertEquals("4000 × 3000", rows[R.string.df_camera_dimensions])
        assertFalse(rows.containsKey(R.string.df_camera_aperture))
    }

    @Test fun missingOrInvalidMetadataDoesNotCreateInventedValues() {
        assertTrue(PhotoExif().rows().isEmpty())
        assertTrue(PhotoExif(model = " ", aperture = Double.NaN, iso = 0, longitude = 23.0,
            width = -1, height = 42, exposureSeconds = Double.POSITIVE_INFINITY).rows().isEmpty())
    }
}
