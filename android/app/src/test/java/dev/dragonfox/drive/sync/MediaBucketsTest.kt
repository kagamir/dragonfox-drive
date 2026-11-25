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
    private fun stamps(files: List<File>) = files.associateWith { it.lastModified() }
    private fun catalog(depth: Int): List<MediaBucket> =
        collectAlbums(listOf(VolumeRoot(root, emptyList())), depth, { true }, ::media, ::stamps) {}
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
        // A volume-root photograph owns all in-range descendants; remove it to test the level-five fold separately.
        assertEquals(root, catalog(10).single().directory)
        assertTrue(home.delete())
        val bucketDir = File(root, base)
        val five = catalog(5).single { it.directory == bucketDir }
        assertTrue(five.recursive)
        assertEquals(listOf(direct), five.covers)
        val ten = catalog(10)
        assertEquals(3, ten.sumOf { it.count })
        val boundary = ten.single { it.directory == bucketDir }
        assertTrue(boundary.recursive)
        assertEquals(setOf(direct, deep), boundary.covers.toSet())
        assertEquals(setOf(direct,deep), boundary.page(0,100).toSet())
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
        val albums = collectAlbums(volumes,3,::guard,::media,::stamps) {}
        assertEquals(listOf(allowed), albums.single().covers)
        assertEquals(listOf(allowed), albums.single().page(0,100))
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
        val first = album.page(0, 9)
        val second = album.page(9, 9)
        val last = album.page(18, 9)
        assertEquals(album.covers, first.take(4))
        val expected = (first + second + last).sortedWith(compareByDescending<File> { it.lastModified() }.thenBy { it.path })
        assertEquals(expected, first + second + last)
        assertEquals(24, (first + second + last).toSet().size)
        assertEquals(first, album.page(0, 9))
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
        assertEquals(oldRoot, all.single().directory)
        assertEquals(setOf(parent,top,nested), all.single().covers.toSet())
        assertEquals(setOf(top,nested,parent), uploaded(recursive).toSet())
    }

    @Test fun siblingsStaySeparateWithoutDirectParentMediaAndOrderUsesSnapshotCreationTime() {
        val oldest = file("Pictures/Camera/a.jpg", 2_000L)
        val newest = file("Pictures/Camera/Daily/z.jpg", 1_000L)
        val other = file("Pictures/Screenshots/shot.jpg", 4_000L)
        val third = file("Trips/mountains.jpg", 8_000L)
        file("Pictures/notes.txt")
        val created = mapOf(oldest to 1L, newest to 12L, other to 20L, third to 12L)
        var resolved = 0
        val albums = collectAlbums(listOf(VolumeRoot(root, emptyList())), 8, { true }, ::media, { batch ->
            assertTrue(batch.size <= 128)
            resolved += batch.size
            batch.associateWith(created::getValue)
        }) {}
        assertEquals(listOf(other.parentFile, oldest.parentFile, third.parentFile), albums.map { it.directory })
        val camera = albums[1]
        assertEquals(listOf(newest, oldest), camera.covers)
        assertTrue(camera.recursive)
        val later = file("Pictures/Camera/Next/tomorrow.jpg")
        assertTrue(newest.delete())
        assertEquals(listOf(newest, oldest), camera.page(0, 1) + camera.page(1, Int.MAX_VALUE))
        assertEquals(emptyList<File>(), camera.page(Int.MAX_VALUE, 40))
        assertEquals(4, resolved)
        val selected = setOf(camera.directory.path)
        assertEquals(setOf(oldest, later), uploaded(SyncConfig(localFolders=selected, recursiveFolders=selected, maxDepth=8)).toSet())
    }

    @Test fun levelFiveStillGroupsEmptyParentsAndNestedVolumeIsNeverMerged() {
        val base = File(root, "A/B/C/Level5")
        val a = file("A/B/C/Level5/X/one.jpg")
        val b = file("A/B/C/Level5/Y/folder/two.mp4")
        val card = File(root,"A/Card")
        val cardPicture = file("A/Card/one.jpg")
        val volumes = listOf(VolumeRoot(root, emptyList()), VolumeRoot(card, listOf("CARD")))
        val groups = collectAlbums(volumes, 10, { true }, ::media, ::stamps) {}
        assertEquals(setOf(base,card), groups.map { it.directory }.toSet())
        assertEquals(setOf(a,b), groups.single { it.directory == base }.page(0,9).toSet())
        val top = file("A/direct.jpg")
        val merged = collectAlbums(volumes, 10, { true }, ::media, ::stamps) {}
        assertEquals(setOf(cardPicture), merged.single { it.directory == card }.page(0,9).toSet())
        val main = merged.single { it.directory == top.parentFile }
        assertEquals(setOf(top,a,b), main.page(0,9).toSet())
        val selected = setOf(main.directory.path, card.path)
        val cfg = SyncConfig(localFolders=selected, recursiveFolders=selected, maxDepth=10)
        val uploads = selectedFiles(cfg, volumes.map { it.dir }, { true }, {}).toList()
        assertEquals(4,uploads.size)
        assertEquals(setOf(top,a,b,cardPicture),uploads.toSet())
    }

    @Test fun cancellationInterruptsGroupedScanAndBatchedTimeLookupIsBounded() {
        repeat(300) { file("A/${it}.jpg") }
        val sizes = mutableListOf<Int>()
        val albums = collectAlbums(listOf(VolumeRoot(root, emptyList())),5,{ true },::media,
            { batch -> sizes.add(batch.size); stamps(batch) }) {}
        assertEquals(listOf(128,128,44),sizes)
        val large = albums.single()
        assertEquals(300, large.count)
        assertEquals(large.page(59,3), listOf(large.fileAt(59), large.fileAt(60), large.fileAt(61)))
        assertThrows(CancellationException::class.java) {
            collectAlbums(listOf(VolumeRoot(root, emptyList())), 5, { true }, ::media, ::stamps) {
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
