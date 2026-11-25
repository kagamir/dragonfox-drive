package dev.dragonfox.drive.sync

import java.io.File
import java.nio.file.attribute.FileTime
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaCreatedTimesTest {
    private val root = File("/storage/emulated/0")
    private fun stamp(millis: Long) = FileTime.fromMillis(millis)

    @Test fun distinctBirthWinsEvenWhenModificationWasRestoredFromAnOlderCopy() {
        val older = File(root, "older.jpg")
        val copied = File(root, "copied.jpg")
        val submillis = File(root, "ns.jpg")
        val zeroEpoch = File(root, "zero.jpg")
        val times = mapOf(
            older to MediaFileTimes(stamp(1_000), stamp(3_000)),
            copied to MediaFileTimes(stamp(4_000), stamp(500)),
            submillis to MediaFileTimes(FileTime.from(5_000_001, TimeUnit.MICROSECONDS), stamp(5_000)),
            zeroEpoch to MediaFileTimes(stamp(0), stamp(3_000)),
        )
        val source = MediaCreatedTimes(times::getValue, { mapOf(root to "external_primary") }) { _, batch ->
            assertEquals(listOf(zeroEpoch), batch)
            mapOf(zeroEpoch.path to 7L)
        }
        assertEquals(mapOf(older to 1_000L, copied to 4_000L, submillis to 5_000L, zeroEpoch to 7_000L),
            source.read(times.keys.toList()))
    }

    @Test fun ambiguousBirthUsesIndexedSecondsBeforeMtimeAndRejectsMissingOrInvalidDates() {
        val indexed = File(root, "Camera/a'b.jpg")
        val unknown = File(root, "unindexed.png")
        val overflow = File(root, "bad.mp4")
        val missingDate = File(root, "missing.jpg")
        val unknownVolume = File("/storage/emulated/01/neighbor.jpg")
        val noTimes = File(root, "vanished.jpg")
        val files = listOf(indexed, unknown, overflow, missingDate, unknownVolume, noTimes)
        val source = MediaCreatedTimes(
            { if (it == noTimes) MediaFileTimes(null, stamp(0)) else MediaFileTimes(stamp(900), stamp(900)) },
            { mapOf(root to "external_primary") },
        ) { name, batch ->
            assertEquals("external_primary", name)
            assertEquals(files - unknownVolume, batch)
            mapOf(indexed.path to 12L, overflow.path to Long.MAX_VALUE, missingDate.path to 0L)
        }
        assertEquals(listOf(12_000L, 900L, 900L, 900L, 900L, 0L), files.map(source.read(files)::getValue))
    }

    @Test fun queriesOnlyEligibleAmbiguousMediaInBoundedBatchesPerVolume() {
        val nested = File(root, "card")
        val files = (1..300).map { File(root, "Pictures/sub/entry-$it.jpg") }
        val other = File(nested, "Pictures/other.png")
        val excluded = File(root, "Pictures/sub/outside-the-input.jpg")
        val calls = mutableListOf<Pair<String, List<File>>>()
        var volumeLookups = 0
        val source = MediaCreatedTimes({ MediaFileTimes(null, stamp(9)) }, {
            volumeLookups++
            mapOf(root to "main", nested to "sd")
        }) { volume, batch ->
            calls.add(volume to batch)
            if (volume == "sd") throw SecurityException()
            batch.associate { it.path to 2L } + (excluded.path to 5L)
        }
        val first = source.read(files + other)
        assertEquals(files.map { 2_000L }, files.map(first::getValue))
        assertEquals(9L, first.getValue(other))
        assertTrue(excluded !in first)
        assertEquals(files, calls.filter { it.first == "main" }.flatMap { it.second })
        assertEquals(listOf(128, 128, 44), calls.filter { it.first == "main" }.map { it.second.size })
        assertEquals(listOf(other), calls.single { it.first == "sd" }.second)
        source.read(listOf(other))
        assertEquals(1, volumeLookups)
    }

    @Test fun queryOrVolumeDisappearingRetainsFilesystemFallback() {
        val file = File(root, "file.jpg")
        val times = { _: File -> MediaFileTimes(null, stamp(42)) }
        val unmounted = MediaCreatedTimes(times, { mapOf(root to "card") }) { _, _ ->
            throw IllegalArgumentException("gone")
        }
        val denied = MediaCreatedTimes(times, { throw SecurityException() }) { _, _ -> error("no such volume") }
        assertEquals(42L, unmounted.read(listOf(file)).getValue(file))
        assertEquals(42L, denied.read(listOf(file)).getValue(file))
    }
}
