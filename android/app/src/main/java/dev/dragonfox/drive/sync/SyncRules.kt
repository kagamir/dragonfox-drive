package dev.dragonfox.drive.sync

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Locale

enum class SyncMode { MEDIA, ALL }

data class SyncConfig(
    val localFolders: Set<String> = emptySet(),
    val remoteFolderId: String? = null,
    val mode: SyncMode = SyncMode.MEDIA,
    val enabled: Boolean = false,
)

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
    val unique = paths.map { File(it).absoluteFile.normalize() }.distinct().sortedBy { it.path.length }
    val selected = mutableListOf<File>()
    for (dir in unique) {
        if (selected.none { dir.toPath().startsWith(it.toPath()) }) selected.add(dir)
    }
    return selected
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
): Sequence<File> = sequence {
    val stack = ArrayDeque(roots)
    while (stack.isNotEmpty()) {
        checkActive()
        val dir = stack.removeLast()
        if (!includeDirectory(dir) || Files.isSymbolicLink(dir.toPath())) continue
        val children = dir.listFiles()
        if (children == null) {
            unreadable(dir)
            continue
        }
        for (child in children) {
            checkActive()
            if (Files.isSymbolicLink(child.toPath())) continue
            if (child.isDirectory) stack.addLast(child)
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
