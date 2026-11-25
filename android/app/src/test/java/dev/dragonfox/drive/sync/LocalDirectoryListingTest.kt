package dev.dragonfox.drive.sync

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LocalDirectoryListingTest {
    @get:Rule val temp = TemporaryFolder()

    private fun listing(vararg roots: File, depth: Int = 5, checkActive: () -> Unit = {}) =
        LocalDirectoryListing(roots.toList(), depth, { if (it.extension == "txt") "text/plain" else "application/octet-stream" }, checkActive)

    private fun unavailable(action: () -> Unit) {
        val cause = assertThrows(Exception::class.java) { action() }
        assertTrue("Expected a filesystem access error, got $cause", cause is IOException || cause is SecurityException)
    }

    @Test fun directoriesPrecedeFilesAndCaseTiesHaveAStableOrder() {
        val root = temp.newFolder("volume")
        val zebra = File(root, "zebra").apply { mkdir() }
        val camera = File(root, "Camera").apply { mkdir() }
        val lower = File(root, "image.txt").apply { writeText("read me") }
        val upper = File(root, "IMAGE.txt").apply { writeText("") }
        val hidden = File(root, ".keep").apply { createNewFile() }
        val listing = listing(root)
        val children = listing.entries(root)
        assertEquals(listOf(camera, zebra, hidden, upper, lower), children.map { it.file })
        assertTrue(children.first().isDirectory)
        assertNull(children.first().size)
        val file = children.last()
        assertFalse(file.isDirectory)
        assertEquals("text/plain", file.mime)
        assertEquals(lower.length(), file.size)
        assertEquals(lower.lastModified(), file.modified)
        assertEquals(0L, listing.fileEntry(upper).size)
        assertEquals(file, listing.fileEntry(lower))
    }

    @Test fun everyVolumeStartsAtLevelOneAndTheBoundaryIncludesDirectFiles() {
        val one = temp.newFolder("phone")
        val two = temp.newFolder("card")
        val deeper = File(one, "A/B/C").apply { mkdirs() }
        val boundary = deeper.parentFile!!
        val direct = File(boundary, "notes").apply { createNewFile() }
        val hidden = File(deeper, "deeper.txt").apply { createNewFile() }
        val atRoot = File(two, "on-card.bin").apply { createNewFile() }
        val listing = listing(one, two, depth = 3)
        assertEquals(setOf(one, two), listing.entries(null).map { it.file }.toSet())
        assertEquals(listOf(direct), listing.entries(boundary).map { it.file })
        assertEquals(direct, listing.fileEntry(direct).file)
        unavailable { listing.entries(deeper) }
        unavailable { listing.fileEntry(hidden) }

        val rootOnly = listing(one, two, depth = 1)
        assertTrue(rootOnly.entries(one).isEmpty())
        assertEquals(listOf(atRoot), rootOnly.entries(two).map { it.file })
        assertEquals(atRoot, rootOnly.fileEntry(atRoot).file)
        unavailable { rootOnly.entries(boundary.parentFile!!) }
    }

    @Test fun forbiddenAndroidDirectoriesAndOutsidePathsAreExcludedAtBothEntryPoints() {
        val root = temp.newFolder("volume")
        val android = File(root, "aNdRoId").apply { mkdir() }
        val data = File(android, "DaTa").apply { mkdir() }
        val obb = File(android, "oBb").apply { mkdir() }
        val media = File(android, "media").apply { mkdir() }
        val prefixNeighbor = temp.newFolder("volume-extra")
        val listing = listing(root)
        assertEquals(listOf(media), listing.entries(android).map { it.file })
        for (unavailableDirectory in listOf(data, obb, prefixNeighbor)) {
            val file = File(unavailableDirectory, "blocked.txt").apply { createNewFile() }
            unavailable { listing.entries(unavailableDirectory) }
            unavailable { listing.fileEntry(file) }
        }
        unavailable { listing.entries(File(media, "../media")) }
        unavailable { listing.fileEntry(File(media, "../DaTa/blocked.txt")) }
        assertTrue(data.deleteRecursively())
        assertTrue(data.createNewFile())
        assertEquals(listOf(media), listing.entries(android).map { it.file })
        unavailable { listing.fileEntry(data) }
    }

    @Test fun linksAndPreviewsUnderAnAncestorReplacedSinceListingAreRejected() {
        val root = temp.newFolder("volume")
        val selected = File(root, "selected").apply { mkdir() }
        val subdir = File(selected, "sub").apply { mkdir() }
        val original = File(subdir, "details.txt").apply { writeText("original") }
        val outside = temp.newFolder("outside")
        val outsideSub = File(outside, "sub").apply { mkdir() }
        val foreign = File(outsideSub, original.name).apply { writeText("outside") }
        val linkFile = File(root, "linked.txt")
        Files.createSymbolicLink(linkFile.toPath(), foreign.toPath())
        val listing = listing(root)
        assertEquals(listOf(selected), listing.entries(root).map { it.file })
        assertEquals(original, listing.entries(subdir).single().file)
        unavailable { listing.fileEntry(linkFile) }
        Files.move(selected.toPath(), File(root, "renamed").toPath())
        Files.createSymbolicLink(selected.toPath(), outside.toPath())
        assertEquals(listOf("renamed"), listing.entries(root).map { it.file.name })
        unavailable { listing.entries(selected) }
        unavailable { listing.entries(subdir) }
        unavailable { listing.fileEntry(original) }
    }

    @Test fun emptyDirectoriesAreDistinctFromStaleOrWrongTypeRequests() {
        val root = temp.newFolder("volume")
        val empty = File(root, "empty").apply { mkdir() }
        val plain = File(root, "document.bin").apply { createNewFile() }
        val listing = listing(root)
        assertTrue(listing.entries(empty).isEmpty())
        unavailable { listing.entries(plain) }
        unavailable { listing.fileEntry(empty) }
        assertTrue(empty.delete())
        unavailable { listing.entries(empty) }
        assertTrue(plain.delete())
        unavailable { listing.fileEntry(plain) }
    }

    @Test fun specialFilesystemEntriesCannotBePreviewedOrListedAsOrdinaryFiles() {
        val device = File("/dev/null")
        assumeTrue(device.exists() && !device.isFile && !device.isDirectory)
        val devices = device.parentFile!!
        val listing = listing(devices, depth = 1)
        assertFalse(listing.entries(devices).any { it.file == device })
        unavailable { listing.fileEntry(device) }
    }

    @Test fun unreadableDirectoryReportsAccessFailure() {
        val root = temp.newFolder("volume")
        val denied = File(root, "denied").apply { mkdir() }
        try {
            assumeTrue(denied.setReadable(false, false) && !denied.canRead())
            for (action in listOf({ listing(root).entries(denied) }, { listing(denied).entries(null) })) {
                val error = assertThrows(Exception::class.java) { action() }
                assertTrue(error is SecurityException || error is java.nio.file.AccessDeniedException)
            }
            assertEquals(listOf(root), listing(denied, root).entries(null).map { it.file })
            assertTrue(listing().entries(null).isEmpty())
        } finally {
            denied.setReadable(true, true)
        }
    }

    @Test fun cancellationInterruptsLargeDirectoryEnumeration() {
        val root = temp.newFolder("volume")
        repeat(100) { File(root, "$it.txt").createNewFile() }
        var checkpoints = 0
        val listing = listing(root, checkActive = {
            if (++checkpoints == 4) throw CancellationException("left browser")
        })
        assertThrows(CancellationException::class.java) { listing.entries(root) }
    }
}
