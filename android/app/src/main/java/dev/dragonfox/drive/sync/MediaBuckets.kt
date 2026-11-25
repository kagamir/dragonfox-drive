package dev.dragonfox.drive.sync

import java.io.File

/** Immutable per-scan path snapshot. Identity equality keeps Compose from comparing every entry. */
internal class MediaBucket(
    val directory: File, private val files: List<File>, val recursive: Boolean,
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

private const val ALBUM_DISPLAY_DEPTH = 5 // The volume root is level one.

private data class TimedFile(val file: File, val created: Long)

/** Group by actual parent, folding only files below level five into that level's directory.
 * The separate hard scan limit is applied by walkFiles before those files are enumerated. */
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
                val maxRelativeDepth = ALBUM_DISPLAY_DEPTH - 1
                val display = if (rel.nameCount > maxRelativeDepth) {
                    root.toPath().resolve(rel.subpath(0, maxRelativeDepth)).toFile()
                } else parent
                group = groups.getOrPut(display) { ArrayList() }
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
        val includesDescendants = maxDepth > ALBUM_DISPLAY_DEPTH && storageDepth(directory, roots) == ALBUM_DISPLAY_DEPTH
        albums.add(firstDate to MediaBucket(directory, ordered, recursive = includesDescendants))
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
