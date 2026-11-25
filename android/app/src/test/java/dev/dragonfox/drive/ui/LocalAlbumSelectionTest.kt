package dev.dragonfox.drive.ui

import dev.dragonfox.drive.sync.MediaBucket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LocalAlbumSelectionTest {
    private val directory = File("/storage/DCIM/Trips/2025/Spring")
    private val saved = setOf(directory.absolutePath)

    private fun album(count: Int, recursive: Boolean) =
        MediaBucket(directory, List(count) { File(directory, "$it.jpg") }, recursive)

    @Test fun recursiveRuleStillCoversEveryVisiblePhotoWhenDepthShrinks() {
        val joined = album(6, recursive = true)
        assertTrue(joined.fullySelected(saved, saved))
        val shallow = album(2, recursive = false)
        assertTrue(shallow.fullySelected(saved, saved))
        assertFalse(shallow.fullySelected(emptySet(), emptySet()))
    }

    @Test fun directRuleDoesNotSelectNewlyVisibleDescendants() {
        val direct = album(2, recursive = false)
        assertTrue(direct.fullySelected(saved, emptySet()))
        assertFalse(album(6, recursive = true).fullySelected(saved, emptySet()))
    }
    @Test fun mergedAlbumLeavesSavedChildScopesAloneUntilTheUserSelectsIt() {
        val album = album(4, recursive = true)
        val child = File(directory, "Portraits").absolutePath
        val other = File(directory.parentFile, directory.name + "-other").absolutePath
        val previous = setOf(child, other)
        assertFalse(album.fullySelected(previous, setOf(child)))
        assertFalse(album.inheritedFrom(setOf(child)))
        val explicit = previous + directory.absolutePath
        assertTrue(album.fullySelected(explicit, setOf(directory.absolutePath)))
        assertEquals(setOf(other), explicit - album.rulesToClear(explicit))
    }

    @Test fun clearingDirectAlbumDoesNotClearSeparateChildScopes() {
        val direct = album(1, recursive = false)
        val child = File(directory, "Portraits").absolutePath
        val active = setOf(directory.absolutePath, child)
        assertEquals(setOf(child), active - direct.rulesToClear(active))
        assertTrue(direct.inheritedFrom(setOf(directory.parentFile!!.absolutePath)))
    }

}
