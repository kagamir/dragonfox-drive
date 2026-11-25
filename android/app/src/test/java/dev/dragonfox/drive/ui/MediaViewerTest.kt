package dev.dragonfox.drive.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import org.junit.Assert.assertEquals
import org.junit.Test

class MediaViewerTest {
    @Test fun landscapePhotoInPortraitOnlyPansWhereItOverflows() {
        val viewport = IntSize(400, 800)
        val image = IntSize(800, 400)
        assertEquals(Offset.Zero, clampPhotoPan(viewport, image, 1f, Offset(300f, 200f)))
        assertEquals(Offset(200f, 0f), clampPhotoPan(viewport, image, 2f, Offset(800f, -800f)))
    }

    @Test fun tallImageCanOnlyPanVerticallyUntilItsWidthExceedsTheViewport() {
        assertEquals(Offset(0f, -200f),
            clampPhotoPan(IntSize(800, 400), IntSize(300, 600), 2f, Offset(-800f, -600f)))
    }

    @Test fun playbackClockIncludesHoursOnlyForLongVideos() {
        assertEquals("0:00", playbackTime(-1))
        assertEquals("1:01", playbackTime(61_999))
        assertEquals("1:01:01", playbackTime(3_661_000))
    }
}
