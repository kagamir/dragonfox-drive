package dev.dragonfox.drive.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class MediaBucketsTest {
    @get:Rule val temp = TemporaryFolder()
    private val root get() = temp.root
    private fun file(path: String, timestamp: Long = 100_000): File = File(root, path).apply {
        parentFile!!.mkdirs()
        writeText(path)
        setLastModified(timestamp)
    }
    private fun media(f: File) = f.extension in setOf("jpg","jpeg","mp4")
    private fun catalog(depth: Int): List<MediaBucket> =
        collectAlbums(listOf(VolumeRoot(root, emptyList())), depth, { true }, ::media) {}
    private fun uploaded(cfg: SyncConfig) = selectedFiles(cfg, listOf(root), { true }, {}).filter { cfg.mode == SyncMode.ALL || media(it) }.toList()

    @Test fun hardDepthFromVolumeAndFiveLevelDisplayMatchTheDocumentedExample() {
        val home = file("root.jpg")
        val base = "downloads/pic/4/5"
        val direct = file("$base/direct.jpg")
        val deep = file("$base/6/7/8/9/test.jpeg")
        val hidden = file("$base/6/7/8/9/10/11/too-deep.jpg")
        val other = file("downloads/pic/4/sibling/sibling.mp4")
        val txt = file("$base/6/notes.txt")
        val rootOnly = catalog(1).single()
        assertEquals(root, rootOnly.directory)
        assertEquals(listOf(home), rootOnly.covers)
        assertEquals(1, storageDepth(root,listOf(root)))
        assertEquals(9, storageDepth(deep.parentFile!!,listOf(root)))
        assertEquals(1, SyncConfig(maxDepth = 0).normalized().maxDepth)
        val bucketDir = File(root, base)
        val five = catalog(5).single { it.directory == bucketDir }
        assertFalse(five.recursive)
        assertEquals(listOf(direct), five.covers)
        val ten = catalog(10)
        assertEquals(4, ten.sumOf { it.count })
        val boundary = ten.single { it.directory == bucketDir }
        assertTrue(boundary.recursive)
        assertEquals(setOf(direct, deep), boundary.covers.toSet())
        val cursor = AlbumCursor(boundary, listOf(root), { true }, ::media)
        assertEquals(setOf(direct,deep), cursor.page(0,100) {}.toSet())
        val cfg = SyncConfig(localFolders = setOf(bucketDir.path), recursiveFolders = setOf(bucketDir.path))
        assertEquals(setOf(direct), uploaded(cfg.copy(maxDepth = 5)).toSet())
        assertEquals(setOf(direct,deep), uploaded(cfg.copy(maxDepth = 10)).toSet())
        val all = uploaded(cfg.copy(mode = SyncMode.ALL, maxDepth = 10))
        assertEquals(setOf(direct,deep,txt), all.toSet())
        assertTrue(hidden !in all && other !in all)
        assertEquals(listOf("downloads","pic","4","5","6","7","8","9"), remotePath(deep.parentFile!!, listOf(VolumeRoot(root, emptyList()))))
    }

    @Test fun scanNeverOpensADirectoryBeyondTheCapIncludingExplicitOldSelections() {
        file("Downloads/sub/nested/hidden.jpg")
        val allowed = file("Downloads/sub/visible.jpg")
        val deep = File(root,"Downloads/sub/nested")
        val source = File(root,"Downloads/sub")
        val volumes = listOf(VolumeRoot(root, emptyList()))
        fun guard(dir: File): Boolean {
            assertTrue("Visited $dir past hard limit", storageDepth(dir, listOf(root))!! <= 3)
            return true
        }
        val albums = collectAlbums(volumes,3,::guard,::media) {}
        assertEquals(listOf(allowed), albums.single().covers)
        val cursor = AlbumCursor(albums.single().copy(recursive = true), listOf(root), ::guard, ::media)
        assertEquals(listOf(allowed),cursor.page(0,100) {})
        for (mode in SyncMode.entries) {
            val rule = SyncConfig(localFolders=setOf(deep.path),maxDepth=3,mode=mode,recursiveFolders=setOf(deep.path))
            assertEquals(emptyList<File>(),selectedFiles(rule,listOf(root),::guard,{}).toList())
            val within = rule.copy(localFolders=setOf(source.path), recursiveFolders=setOf(source.path))
            assertEquals(listOf(allowed),selectedFiles(within,listOf(root),::guard,{}).toList())
            // Each new periodic/manual pass uses the current setting; lowering depth hides newly added deeper files.
            val loosened = within.copy(maxDepth=4)
            assertEquals(2,uploaded(loosened).size)
            file("Downloads/sub/nested/another.jpg")
            assertTrue(uploaded(loosened).size >= 2)
            assertEquals(listOf(allowed),uploaded(within))
            File(deep, "another.jpg").delete()
        }
    }

    @Test fun coverOrderIsStableAndUsesFourMostRecentMedia() {
        repeat(24) { file("Pictures/${it}.jpg", (100 + it / 3) * 1000L) }
        Files.createSymbolicLink(File(root,"Pictures/mirror.jpg").toPath(), File(root,"Pictures/7.jpg").toPath())
        val album = catalog(5).single()
        assertEquals(24, album.count)
        assertEquals(listOf("21.jpg","22.jpg","23.jpg","18.jpg"), album.covers.map { it.name })
        val cursor = AlbumCursor(album, listOf(root), { true }, ::media)
        val first = cursor.page(0, 9) {}
        val second = cursor.page(9, 9) {}
        val last = cursor.page(18, 9) {}
        assertEquals(24, (first + second + last).toSet().size)
        assertEquals(first, cursor.page(0, 9) {})
        assertEquals(album.count, uploaded(SyncConfig(localFolders = setOf(album.directory.path))).size)
    }

    @Test fun exactAndLegacyRecursiveSelectionsDoNotDistortNaturalAlbums() {
        val top = file("DCIM/archive/2025/pics/direct.jpg")
        val nested = file("DCIM/archive/2025/pics/deeper/sub.jpg")
        val bucket = top.parentFile!!
        val exact = SyncConfig(localFolders = setOf(bucket.path), maxDepth = 10)
        val legacy = exact.copy(recursiveFolders = setOf(bucket.path))
        val natural = catalog(10).single()
        assertEquals(setOf(top), uploaded(exact).toSet())
        assertEquals(2, natural.count)
        assertTrue(natural.recursive)
        assertEquals(setOf(top,nested), uploaded(legacy).toSet())
        assertEquals(setOf(top), uploaded(legacy.copy(maxDepth = 5)).toSet())
        val parent = file("DCIM/direct.jpg")
        val oldRoot = File(root, "DCIM")
        val recursive = legacy.copy(localFolders = setOf(oldRoot.path),recursiveFolders = setOf(oldRoot.path))
        val all = catalog(10)
        assertEquals(3, all.sumOf { it.count })
        assertEquals(listOf(parent), all.single { it.directory == oldRoot }.covers)
        assertEquals(setOf(top,nested,parent), uploaded(recursive).toSet())
    }

    @Test fun cancellationInterruptsSummaryAndAlbumPaging() {
        repeat(100) { file("A/${it}.jpg") }
        val bucket = catalog(2).single()
        val cursor = AlbumCursor(bucket, listOf(root), { true }, ::media)
        var calls = 0
        assertThrows(CancellationException::class.java) {
            cursor.page(0,100) { if (++calls == 6) throw CancellationException() }
        }
        assertThrows(CancellationException::class.java) {
            collectAlbums(listOf(VolumeRoot(root, emptyList())), 5, { true }, ::media) {
                throw CancellationException()
            }
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun idleTimerTracksChangesAndManualRefreshWithoutBusyLoop() = runTest {
        val intervals = MutableStateFlow(45)
        val manual = Channel<Unit>(Channel.CONFLATED)
        val wait = async { awaitNextScan(intervals, manual.receiveAsFlow()) }
        runCurrent()
        advanceTimeBy(10_000)
        intervals.value = 0 // bad persisted/user input clamps to the 5-second minimum
        runCurrent()
        advanceTimeBy(4_999)
        assertFalse(wait.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        assertTrue(wait.isCompleted)
        val again = async { awaitNextScan(intervals, manual.receiveAsFlow()) }
        runCurrent()
        assertFalse(again.isCompleted)
        manual.send(Unit)
        again.await()
    }
}
