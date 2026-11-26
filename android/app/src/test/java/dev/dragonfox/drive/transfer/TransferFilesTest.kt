package dev.dragonfox.drive.transfer

import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.CloudFolder
import java.io.IOException
import kotlinx.coroutines.CancellationException
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class TransferFilesTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun knownLengthOpensProviderOnlyWhenConsumed() {
        val bytes = byteArrayOf(1, 2, 3)
        var opens = 0
        withUploadSource(3L, temp.root, { opens++; bytes.inputStream() }, {}) { source ->
            assertEquals(3L, source.size)
            assertEquals(0, opens)
            assertArrayEquals(bytes, source.open().use { it.readBytes() })
        }
        assertEquals(1, opens)
        assertTrue(temp.root.listFiles()!!.isEmpty())
    }

    @Test fun unknownLengthIsStreamedOnceAndCanBeReadAgainIncludingEmptyInputs() {
        for (bytes in listOf(byteArrayOf(), ByteArray(420_000) { it.toByte() })) {
            var opens = 0
            withUploadSource(null, temp.root, { opens++; bytes.inputStream() }, {}) { source ->
                assertTrue(temp.root.listFiles()!!.isEmpty())
                assertEquals(bytes.size.toLong(), source.size)
                repeat(2) { assertArrayEquals(bytes, source.open().use { it.readBytes() }) }
            }
            assertEquals(1, opens)
        }
    }

    @Test fun sourceReadFailuresAndCancellationLeaveNoPrivatePlaintextFiles() {
        var checkpoints = 0
        assertThrows(CancellationException::class.java) {
            withUploadSource(null, temp.root, { ByteArray(280_000).inputStream() }, {
                if (++checkpoints == 2) throw CancellationException()
            }) { fail("cancelled input was uploaded") }
        }
        assertThrows(IOException::class.java) {
            withUploadSource(null, temp.root, { throw IOException() }, {}) { fail("failed input was uploaded") }
        }
        assertTrue(temp.root.listFiles()!!.isEmpty())
    }

    @Test fun importedFoldersReuseTheirOwnParentsAndHandleFileNameCollisions() {
        val occupied = CloudFile("f", null, "Photos.2025", 12)
        val nested = CloudFolder("nested", "another-folder", "Photos.2025")
        val remote = ImportTree(listOf(nested), listOf(occupied))
        val dir = remote.folder(null, "Photos.2025") { name -> CloudFolder("id", null, name) }
        assertEquals("Photos.2025 (1)", dir.name)
        assertEquals(dir, remote.folder(null, "Photos.2025") { error("already imported") })
        assertEquals(nested, remote.folder("another-folder", "Photos.2025") { error("already exists") })
    }

    @Test fun reimportSkipsMatchingContentUnderOriginalOrNumberedName() {
        val sameName = CloudFile("old", "photos", "photo.jpg", 3)
        val conflict = CloudFolder("folder", "photos", "photo (1).jpg")
        val remote = ImportTree(listOf(conflict), listOf(sameName))
        assertEquals("photo (2).jpg", remote.availableName("photos", sameName.name, 3) { false })
        remote.record(CloudFile("new", "photos", "photo (2).jpg", 3))
        assertNull(remote.availableName("photos", sameName.name, 3) { it.id == "new" })
        assertNull(remote.availableName("photos", sameName.name, 3) { it.id == "old" })
        assertEquals("photo (3).jpg", remote.availableName("photos", sameName.name, 6) { error("different size") })
        assertEquals("photo.jpg", remote.availableName(null, sameName.name, 3) { error("different parent") })
    }

    @Test fun conflictSuffixPreservesExtensionsAndHiddenFiles() {
        assertEquals(".nomedia (1)", suffixed(".nomedia", 1))
        assertEquals("x.tar (2).gz", suffixed("x.tar.gz", 2))
        assertEquals("report (1)", suffixed("report", 1))
        assertEquals("東京 (1).png", suffixed("東京.png", 1))
    }
}
