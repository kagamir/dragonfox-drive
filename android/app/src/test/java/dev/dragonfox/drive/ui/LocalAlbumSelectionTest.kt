package dev.dragonfox.drive.ui

import dev.dragonfox.drive.sync.MediaBucket
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LocalAlbumSelectionTest {
    private val directory = File("/storage/DCIM/Trips/2025/Spring")
    private val saved = setOf(directory.absolutePath)

    @Test fun recursiveRuleStillCoversEveryVisiblePhotoWhenDepthShrinks() {
        val joined = MediaBucket(directory, 6, emptyList(), recursive = true, scanDepth = 10)
        assertTrue(joined.fullySelected(saved, saved))
        val shallow = joined.copy(count = 2, recursive = false, scanDepth = 5)
        assertTrue(shallow.fullySelected(saved, saved))
        assertFalse(shallow.fullySelected(emptySet(), emptySet()))
    }

    @Test fun directRuleDoesNotSelectNewlyVisibleDescendants() {
        val direct = MediaBucket(directory, 2, emptyList(), recursive = false, scanDepth = 5)
        assertTrue(direct.fullySelected(saved, emptySet()))
        assertFalse(direct.copy(count = 6, recursive = true, scanDepth = 10).fullySelected(saved, emptySet()))
    }
}
