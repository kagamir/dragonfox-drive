package dev.dragonfox.drive.sync

import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.CloudFolder
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class SyncRulesTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun mixedMediaTreeAndOverlappingRoots() {
        val root = temporary.newFolder("DCIM")
        val child = File(root, "Camera").apply { mkdir() }
        val other = temporary.newFile("secret.jpg")
        listOf("one.JPG", "two.m4v", "three.pdf", "unknown").forEach { File(child, it).writeText(it) }
        Files.createSymbolicLink(File(child, "external.jpg").toPath(), other.toPath())
        Files.createSymbolicLink(File(child, "loop").toPath(), root.toPath())
        val roots = sourceDirectories(setOf(child.path, root.path))
        assertEquals(listOf(root), roots)
        val files = walkFiles(roots, { true }, {}).toList()
        fun names(mode: SyncMode) = files.filter { file ->
            mode.accepts(fileMime(file) { if (it == "jpg") "image/jpeg" else null })
        }.map { it.name }.sorted()
        assertEquals(listOf("one.JPG", "two.m4v"), names(SyncMode.MEDIA))
        assertEquals(listOf("one.JPG", "three.pdf", "two.m4v", "unknown"), names(SyncMode.ALL))
    }

    @Test fun volumeRelativePathsPreserveOverlappingNames() {
        val primary = temporary.newFolder("primary")
        val sd = temporary.newFolder("sdcard")
        val volumes = listOf(VolumeRoot(primary, emptyList()), VolumeRoot(sd, listOf("ABCD")))
        assertEquals(listOf("DCIM","Camera"), remotePath(File(primary, "DCIM/Camera"), volumes))
        assertEquals(listOf("ABCD","DCIM","Camera"), remotePath(File(sd, "DCIM/Camera"), volumes))
        assertEquals(emptyList<String>(), remotePath(primary, volumes))
        assertNull(remotePath(File("${primary.path}-other/Camera"), volumes))
    }

    @Test fun indexOnlyMatchesReadySnapshotInSelectedDestination() {
        val folders = listOf(CloudFolder("target", null, "Backup"), CloudFolder("pics","target","Pictures"))
        val file = CloudFile("7","pics","one.jpg", 4L,"123")
        val index = CloudIndex(folders, listOf(file))
        assertTrue(index.containsFolder("target"))
        assertFalse(index.containsFolder("deleted"))
        assertEquals(listOf(file), index.candidates("target", listOf("Pictures"), "one.jpg",4))
        assertTrue(index.candidates(null,listOf("Pictures"),"one.jpg",4).isEmpty())
        assertTrue(index.candidates("target",listOf("Pictures"),"one.jpg",5).isEmpty())
        assertTrue(CloudIndex(folders, emptyList()).candidates("target",listOf("Pictures"),"one.jpg",4).isEmpty())
        var creates = 0
        repeat(3) {
            assertEquals("new", index.ensureFolder("target",listOf("Pictures","Raw")) { parent,name ->
                assertEquals("pics", parent)
                creates++
                CloudFolder("new",parent,name)
            })
        }
        assertEquals(1, creates)
    }

    @Test fun deduplicationUsesContent() {
        val first = temporary.newFile("first").apply { writeText("abc") }
        val second = temporary.newFile("second").apply { writeText("xyz") }
        assertEquals(first.length(), second.length())
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", digest(first) {})
        assertNotEquals(digest(first) {}, digest(second) {})
    }

    @Test fun networkCapacityIsConservativeOnMeteredOrUnknownConnections() {
        assertEquals(0, uploadLimit(false,false,50_000))
        assertEquals(1, uploadLimit(true,false,0))
        assertEquals(1, uploadLimit(true,true,50_000))
        assertEquals(2, uploadLimit(true,false,4_000))
        assertEquals(3, uploadLimit(true,false,50_000))
    }

    @Test fun queuedTasksAdaptToNewCapacityAndFinishOnSlowLink() = runBlocking {
        withTimeout(5_000) {
            val capacity = MutableStateFlow(0)
            val starts = Channel<Int>(Channel.UNLIMITED)
            val permits = Channel<Unit>(Channel.UNLIMITED)
            val job = launch {
                uploadWithCapacity((0..5).toList(), capacity) { starts.send(it); permits.receive() }
            }
            yield()
            assertTrue(starts.tryReceive().isFailure)
            capacity.value = 1
            assertEquals(0, starts.receive())
            assertTrue(starts.tryReceive().isFailure)
            capacity.value = 3
            assertEquals(setOf(1,2), setOf(starts.receive(),starts.receive()))
            capacity.value = 1
            repeat(3) { permits.send(Unit) }
            for (item in 3..5) {
                assertEquals(item, starts.receive())
                assertTrue(starts.tryReceive().isFailure)
                permits.send(Unit)
            }
            job.join()
        }
    }
}
