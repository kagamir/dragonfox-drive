package dev.dragonfox.drive.sync

import java.io.File

/** Immutable per-scan path snapshot. Identity equality keeps Compose from comparing every entry. */
internal class MediaBucket(
    val directory: File, private val files: List<File>, val recursive: Boolean = true,
) {
    val count = files.size
    val covers = files.take(4)
    fun fileAt(index: Int): File = files[index]

    fun page(offset: Int, limit: Int): List<File> {
        require(offset >= 0 && limit > 0)
        if (offset >= count) return emptyList()
        val length = minOf(limit, count - offset)
        return files.subList(offset, offset + length)
    }
}

private data class TimedFile(val file: File, val created: Long)

/** Direct files are visited before any child directory. Consequently an album owner, if present,
 * is already known when we encounter a descendant. Only a directory with media or the display
 * depth boundary can become an owner. The physical traversal always respects the scan limit.
 */
internal fun collectAlbums(
    volumes: List<VolumeRoot>, depth: Int, includeDirectory: (File) -> Boolean, isMedia: (File) -> Boolean,
    creationTimes: (List<File>) -> Map<File, Long>, checkActive: () -> Unit,
): List<MediaBucket> {
    val maxDepth = depth.coerceIn(SCAN_DEPTH_RANGE)
    val roots = volumes.map { it.dir }.distinct()
    val groups = mutableMapOf<File, MutableList<TimedFile>>()
    var previousParent: File? = null
    var group: MutableList<TimedFile>? = null
    val files = walkFiles(roots, includeDirectory, checkActive, volumeRoots = roots, maxDepth = maxDepth)
    for (batch in files.filter(isMedia).chunked(128)) {
        checkActive()
        val times = creationTimes(batch)
        for (file in batch) {
            checkActive()
            val parent = file.parentFile ?: continue
            if (previousParent != parent) {
                val root = containingVolume(parent, roots) ?: continue
                val rel = root.toPath().relativize(parent.toPath())
                val display = if (rel.nameCount > 4) root.toPath().resolve(rel.subpath(0, 4)).toFile() else parent
                var ancestor = display
                while (ancestor != root && ancestor !in groups) ancestor = ancestor.parentFile!!
                val owner = if (ancestor in groups) ancestor else display
                group = groups.getOrPut(owner) { ArrayList() }
                previousParent = parent
            }
            group!!.add(TimedFile(file, times.getValue(file)))
        }
    }
    val newest = compareByDescending<TimedFile> { it.created }.thenBy { it.file.path }
    val albums = ArrayList<Pair<Long, MediaBucket>>(groups.size)
    // Discard timestamps as each album is finalized. The UI keeps only an ordered path list;
    // a page is a read-only slice of that list and never requires a second filesystem scan.
    val iterator = groups.iterator()
    while (iterator.hasNext()) {
        checkActive()
        val (directory, entries) = iterator.next()
        var comparisons = 0
        entries.sortWith { a, b ->
            if (++comparisons % 1024 == 0) checkActive()
            newest.compare(a, b)
        }
        val ordered = entries.map { it.file }
        val firstDate = entries.first().created
        albums.add(firstDate to MediaBucket(directory, ordered))
        iterator.remove()
    }
    return albums.sortedWith(compareByDescending<Pair<Long, MediaBucket>> { it.first }.thenBy { it.second.directory.path })
        .map { it.second }
}

internal fun selectedFiles(
    config: SyncConfig, volumeRoots: List<File>, include: (File) -> Boolean, checkActive: () -> Unit, unreadable: (File) -> Unit = {},
): Sequence<File> {
    val recursivePaths = if (config.mode == SyncMode.ALL) config.localFolders
        else config.recursiveFolders.intersect(config.localFolders)
    val byVolume = recursivePaths.groupBy { containingVolume(File(it), volumeRoots) }
        .mapValues { (_, paths) -> sourceDirectories(paths.toSet()).toSet() }
    val recursive = byVolume.values.flatten()
    val direct = config.localFolders.map { File(it).absoluteFile.normalize() }.distinct().filter { candidate ->
        val covered = byVolume[containingVolume(candidate, volumeRoots)].orEmpty()
        generateSequence(candidate) { it.parentFile }.none { it in covered }
    }
    return walkFiles(recursive, include, checkActive, unreadable, volumeRoots = volumeRoots, maxDepth = config.maxDepth) +
        walkFiles(direct, include, checkActive, unreadable, recursive = false, volumeRoots = volumeRoots, maxDepth = config.maxDepth)
}
