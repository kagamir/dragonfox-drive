package dev.dragonfox.drive.sync

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Locale

enum class SyncMode { MEDIA, ALL }

val SCAN_DEPTH_RANGE = 1..32
val SYNC_INTERVAL_RANGE = 5..86400
const val DEFAULT_SCAN_DEPTH = 5
const val DEFAULT_SYNC_INTERVAL_SECONDS = 45

data class SyncConfig(
    val localFolders: Set<String> = emptySet(),
    val remoteFolderId: String? = null,
    val mode: SyncMode = SyncMode.MEDIA,
    val enabled: Boolean = false,
    val maxDepth: Int = DEFAULT_SCAN_DEPTH,
    val intervalSeconds: Int = DEFAULT_SYNC_INTERVAL_SECONDS,
    // Recursive selections always remain subject to the current absolute volume depth limit.
    val recursiveFolders: Set<String> = emptySet(),
) {
    internal fun normalized() = copy(
        localFolders = localFolders.toSet(), recursiveFolders = recursiveFolders.intersect(localFolders),
        maxDepth = maxDepth.coerceIn(SCAN_DEPTH_RANGE), intervalSeconds = intervalSeconds.coerceIn(SYNC_INTERVAL_RANGE),
    )
}

data class UploadTask(val path: String, val sent: Long, val size: Long)

data class SyncStatus(
    val scanning: Boolean = false,
    val online: Boolean = false,
    val running: Boolean = false,
    val tasks: List<UploadTask> = emptyList(),
    val completed: Int = 0,
    val total: Int = 0,
    val errors: List<String> = emptyList(),
    val concurrency: Int = 0,
    val sessionExpired: Boolean = false,
)

internal fun uploadLimit(connected: Boolean, metered: Boolean, upstreamKbps: Int): Int = when {
    !connected -> 0
    metered || upstreamKbps < 2_000 -> 1
    upstreamKbps < 12_000 -> 2
    else -> 3
}

// Formats absent from some Android MIME tables.
private val extraMedia = mapOf(
    "avif" to "image/avif", "heic" to "image/heic", "heif" to "image/heif",
    "dng" to "image/x-adobe-dng", "cr2" to "image/x-canon-cr2", "nef" to "image/x-nikon-nef",
    "arw" to "image/x-sony-arw", "mkv" to "video/x-matroska", "mts" to "video/mp2t",
    "m2ts" to "video/mp2t", "mov" to "video/quicktime", "m4v" to "video/mp4",
)
internal fun fileMime(file: File, lookup: (String) -> String?): String {
    val ext = file.extension.lowercase(Locale.ROOT)
    return extraMedia[ext] ?: lookup(ext) ?: "application/octet-stream"
}

internal fun SyncMode.accepts(mime: String): Boolean =
    this == SyncMode.ALL || mime.startsWith("image/") || mime.startsWith("video/")

internal fun sourceDirectories(paths: Set<String>): List<File> {
    val normalized = paths.mapTo(mutableSetOf()) { File(it).absoluteFile.normalize() }
    return normalized.filter { dir -> generateSequence(dir.parentFile) { it.parentFile }.none { it in normalized } }
}

internal fun containingVolume(dir: File, roots: List<File>) =
    roots.filter { dir.toPath().startsWith(it.toPath()) }.maxByOrNull { it.path.length }

/** The storage volume itself is level 1; files use the depth of their parent directory. */
fun storageDepth(dir: File, roots: List<File>): Int? {
    val path = dir.absoluteFile.normalize()
    val volume = containingVolume(path, roots) ?: return null
    return 1 + path.toPath().nameCount - volume.toPath().nameCount
}

internal data class VolumeRoot(val dir: File, val prefix: List<String>)

internal fun remotePath(directory: File, volumes: List<VolumeRoot>): List<String>? {
    val root = volumes.filter { directory.toPath().startsWith(it.dir.toPath()) }.maxByOrNull { it.dir.path.length } ?: return null
    return root.prefix + directory.relativeTo(root.dir).path.split(File.separatorChar).filter { it.isNotEmpty() }
}

// Do not follow symlinks, including links to another volume or back to a parent.
internal fun walkFiles(
    roots: List<File>, includeDirectory: (File) -> Boolean, checkActive: () -> Unit,
    unreadable: (File) -> Unit = {},
    recursive: Boolean = true,
    volumeRoots: List<File> = roots, maxDepth: Int = DEFAULT_SCAN_DEPTH,
): Sequence<File> = sequence {
    val hardLimit = maxDepth.coerceIn(SCAN_DEPTH_RANGE)
    val mounts = volumeRoots.toSet()
    val stack = ArrayDeque<Pair<File, Int>>()
    for (source in roots) {
        val volume = containingVolume(source, volumeRoots) ?: continue
        val depth = storageDepth(source, listOf(volume)) ?: continue
        if (depth > hardLimit) continue
        // Also reject a stored selection if an ancestor inside its volume has become a symlink.
        if (generateSequence(source) { it.parentFile }.takeWhile { it != volume }
                .any { Files.isSymbolicLink(it.toPath()) }) continue
        stack.addLast(source to depth)
    }
    while (stack.isNotEmpty()) {
        checkActive()
        val (dir, depth) = stack.removeLast()
        if (!includeDirectory(dir) || Files.isSymbolicLink(dir.toPath())) continue
        val children = dir.listFiles()
        if (children == null) {
            unreadable(dir)
            continue
        }
        for (child in children) {
            checkActive()
            if (Files.isSymbolicLink(child.toPath())) continue
            if (child.isDirectory) {
                if (recursive && depth < hardLimit && child !in mounts) stack.addLast(child to depth + 1)
            }
            else if (child.isFile) yield(child)
        }
    }
}

internal fun ByteArray.hex(): String = joinToString("") { "%02x".format(Locale.ROOT, it) }

internal fun digest(file: File, checkActive: () -> Unit): String {
    val hash = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(128 * 1024)
    file.inputStream().buffered().use { stream ->
        while (true) {
            checkActive()
            val count = stream.read(buffer)
            if (count < 0) break
            hash.update(buffer, 0, count)
        }
    }
    return hash.digest().hex()
}
