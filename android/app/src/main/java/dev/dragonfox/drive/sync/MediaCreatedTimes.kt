package dev.dragonfox.drive.sync

import android.content.Context
import android.database.sqlite.SQLiteException
import android.os.storage.StorageManager
import android.provider.MediaStore
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime

internal data class MediaFileTimes(val created: FileTime?, val modified: FileTime) {
    // When birth time is unsupported, Android's filesystem provider can return mtime or epoch.
    val distinctBirthMillis: Long?
        get() = created?.takeIf { it != modified }?.toMillis()?.takeIf { it > 0 }
}

private fun fileTimes(file: File): MediaFileTimes {
    try {
        val attributes = Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        return MediaFileTimes(attributes.creationTime(), attributes.lastModifiedTime())
    } catch (_: IOException) {
        // The entry may have changed since enumeration. Try the available modification time.
    } catch (_: SecurityException) {
        // Some storage providers allow only limited metadata access.
    } catch (_: UnsupportedOperationException) {
        // Some mount types cannot supply basic file attributes.
    }
    val modified = try { file.lastModified() } catch (_: SecurityException) { 0L }
    return MediaFileTimes(null, FileTime.fromMillis(modified))
}

private fun storageVolumeNames(context: Context): Map<File, String> =
    context.getSystemService(StorageManager::class.java).storageVolumes.mapNotNull { volume ->
        val directory = volume.directory ?: return@mapNotNull null
        val name = volume.mediaStoreVolumeName ?: return@mapNotNull null
        directory to name
    }.toMap()

private fun queryAddedSeconds(context: Context, volume: String, files: List<File>): Map<String, Long> {
    val pathColumn = MediaStore.MediaColumns.DATA
    val dateColumn = MediaStore.MediaColumns.DATE_ADDED
    val arguments = files.map { it.absolutePath }.toTypedArray()
    val placeholders = arguments.joinToString(",") { "?" }
    val result = HashMap<String, Long>()
    context.contentResolver.query(
        MediaStore.Files.getContentUri(volume), arrayOf(pathColumn, dateColumn),
        "$pathColumn IN ($placeholders)", arguments, null,
    )?.use { cursor ->
        while (cursor.moveToNext()) {
            if (!cursor.isNull(0) && !cursor.isNull(1)) result[cursor.getString(0)] = cursor.getLong(1)
        }
    }
    return result
}

/** One instance per scan. MediaStore receives only exact paths already visited within the scan depth. */
internal class MediaCreatedTimes(
    private val stat: (File) -> MediaFileTimes,
    volumeNames: () -> Map<File, String>,
    private val addedSeconds: (String, List<File>) -> Map<String, Long>,
) {
    constructor(context: Context, stat: (File) -> MediaFileTimes = ::fileTimes) : this(stat, { storageVolumeNames(context) },
        { name, files -> queryAddedSeconds(context, name, files) })

    private val volumes by lazy {
        try {
            volumeNames().entries.sortedByDescending { it.key.toPath().nameCount }
        } catch (_: SecurityException) {
            emptyList()
        }
    }

    fun read(files: List<File>): Map<File, Long> {
        val dates = HashMap<File, Long>(files.size)
        val ambiguous = HashMap<String, MutableList<File>>()
        for (file in files) {
            val attributes = stat(file)
            val birth = attributes.distinctBirthMillis
            dates[file] = birth ?: attributes.modified.toMillis().coerceAtLeast(0)
            if (birth != null) continue
            val path = file.toPath()
            val volume = volumes.firstOrNull { path.startsWith(it.key.toPath()) }?.value ?: continue
            ambiguous.getOrPut(volume) { mutableListOf() }.add(file)
        }
        for ((volume, entries) in ambiguous) {
            for (batch in entries.chunked(128)) {
                val indexed = try {
                    addedSeconds(volume, batch)
                } catch (_: SecurityException) {
                    continue
                } catch (_: IllegalArgumentException) {
                    // A removable volume may have been ejected between enumeration and query.
                    continue
                } catch (_: SQLiteException) {
                    continue
                }
                for (file in batch) {
                    val seconds = indexed[file.absolutePath] ?: continue
                    if (seconds in 1..Long.MAX_VALUE / 1000) dates[file] = seconds * 1000
                }
            }
        }
        return dates
    }
}
