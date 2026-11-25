package dev.dragonfox.drive.sync

import java.io.File

/** Files under a level-five album may be grouped together, up to scanDepth from the storage volume. */
data class MediaBucket(val directory: File, val count: Int, val covers: List<File>, val recursive: Boolean,
    val scanDepth: Int = DEFAULT_SCAN_DEPTH)

private data class Cover(val file: File, val modified: Long)

private class Album(val directory: File, val recursive: Boolean) {
    var count = 0
    private val best = ArrayList<Cover>(4)
    fun add(file: File, modified: Long) {
        count++
        val index = best.indexOfFirst { modified > it.modified || modified == it.modified && file.path < it.file.path }
        if (index != -1) {
            best.add(index, Cover(file, modified))
            if (best.size > 4) best.removeAt(4)
        } else if (best.size < 4) best.add(Cover(file, modified))
    }

    fun finish(scanDepth: Int) = MediaBucket(directory, count, best.map { it.file }, recursive, scanDepth)
}

/** Counts and top four covers only. No list of all media or bitmap data is kept. */
internal fun collectAlbums(
    volumes: List<VolumeRoot>, depth: Int, includeDirectory: (File) -> Boolean,
    isMedia: (File) -> Boolean, checkActive: () -> Unit,
): List<MediaBucket> {
    val maxDepth = depth.coerceIn(SCAN_DEPTH_RANGE)
    val displayDepth = minOf(maxDepth, 5)
    val roots = volumes.map { it.dir }
    val files = walkFiles(roots, includeDirectory, checkActive, volumeRoots = roots, maxDepth = maxDepth)
    val albums = mutableMapOf<File, Album>()
    var previousParent: File? = null
    var album: Album? = null
    for (file in files) {
        checkActive()
        if (!isMedia(file)) continue
        val dir = file.parentFile ?: continue
        if (previousParent != dir) {
            val volume = volumes.filter { dir.toPath().startsWith(it.dir.toPath()) }.maxByOrNull { it.dir.path.length }
                ?: continue
            val rel = volume.dir.toPath().relativize(dir.toPath())
            val levels = storageDepth(dir, listOf(volume.dir)) ?: continue
            val display = when {
                displayDepth == 1 -> volume.dir
                levels <= displayDepth -> dir
                else -> volume.dir.toPath().resolve(rel.subpath(0, displayDepth - 1)).toFile()
            }
            album = albums.getOrPut(display) { Album(display, maxDepth > displayDepth && levels >= displayDepth) }
            previousParent = dir
        }
        album?.add(file, file.lastModified())
    }
    return albums.values.map { it.finish(maxDepth) }.sortedWith(compareByDescending<MediaBucket> { it.count }.thenBy { it.directory.path })
}

internal fun selectedFiles(
    config: SyncConfig, volumeRoots: List<File>, include: (File) -> Boolean, checkActive: () -> Unit, unreadable: (File) -> Unit = {},
): Sequence<File> {
    val recursive = sourceDirectories(if (config.mode == SyncMode.ALL) config.localFolders
        else config.recursiveFolders.intersect(config.localFolders))
    val recursiveSet = recursive.toSet()
    val direct = config.localFolders.map { File(it).absoluteFile.normalize() }.distinct()
        .filter { candidate -> generateSequence(candidate) { it.parentFile }.none { it in recursiveSet } }
    return walkFiles(recursive, include, checkActive, unreadable, volumeRoots = volumeRoots, maxDepth = config.maxDepth) +
        walkFiles(direct, include, checkActive, unreadable, recursive = false, volumeRoots = volumeRoots, maxDepth = config.maxDepth)
}

/** Retains only the current directory traversal, so the next page does not scan earlier pages again. */
internal class AlbumCursor(
    val bucket: MediaBucket, volumeRoots: List<File>, includeDirectory: (File) -> Boolean, isMedia: (File) -> Boolean,
) {
    private var check: () -> Unit = {}
    private var position = 0
    private val files = walkFiles(listOf(bucket.directory), includeDirectory, { check() },
        recursive = bucket.recursive, ordered = true, volumeRoots = volumeRoots, maxDepth = bucket.scanDepth).filter(isMedia)
    private var iterator = files.iterator()

    fun page(offset: Int, limit: Int, active: () -> Unit): List<File> {
        require(offset >= 0 && limit > 0)
        check = active
        try {
            if (offset < position) {
                position = 0
                iterator = files.iterator()
            }
            while (position < offset && iterator.hasNext()) {
                iterator.next()
                position++
            }
            val result = ArrayList<File>()
            while (result.size < limit && iterator.hasNext()) {
                result.add(iterator.next())
                position++
            }
            return result
        } finally {
            check = {}
        }
    }
}
