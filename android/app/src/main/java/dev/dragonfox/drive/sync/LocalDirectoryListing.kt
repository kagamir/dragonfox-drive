package dev.dragonfox.drive.sync

import java.io.File
import java.io.IOException
import java.nio.file.AccessDeniedException
import java.nio.file.DirectoryIteratorException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.NotDirectoryException
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes

internal data class LocalEntry(
    val file: File,
    val isDirectory: Boolean,
    val mime: String,
    val size: Long?,
    val modified: Long,
)

private const val DIRECTORY_MIME = "vnd.android.document/directory"

internal fun protectedStoragePath(path: Path, volume: Path): Boolean {
    val relative = volume.relativize(path)
    if (relative.nameCount < 2 || !relative.getName(0).toString().equals("Android", true)) return false
    val name = relative.getName(1).toString()
    return name.equals("data", true) || name.equals("obb", true)
}

internal class LocalDirectoryListing(
    private val roots: List<File>,
    maxDepth: Int,
    private val mime: (File) -> String,
    private val checkActive: () -> Unit,
) {
    private val limit = maxDepth.coerceIn(SCAN_DEPTH_RANGE)

    fun entries(dir: File?): List<LocalEntry> {
        checkActive()
        val entries = ArrayList<LocalEntry>()
        if (dir == null) {
            var deniedRoot: File? = null
            for (root in roots.distinct()) {
                checkActive()
                val path = root.toPath()
                val attrs = try {
                    Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
                } catch (_: NoSuchFileException) {
                    continue
                } catch (_: AccessDeniedException) {
                    deniedRoot = root
                    continue
                }
                if (!attrs.isDirectory) continue
                if (enterable(path)) entries.add(entry(root, attrs)) else deniedRoot = root
            }
            if (entries.isEmpty() && deniedRoot != null) throw AccessDeniedException(deniedRoot.path)
        } else {
            val (volume, depth) = validateDirectory(dir)
            try {
                Files.newDirectoryStream(dir.toPath()).use { stream ->
                    for (child in stream) {
                        checkActive()
                        if (protectedStoragePath(child, volume.toPath())) continue
                        val attrs = attributesIfPresent(child) ?: continue
                        if (attrs.isRegularFile || attrs.isDirectory && depth < limit && enterable(child)) {
                            entries.add(entry(child.toFile(), attrs))
                        }
                    }
                }
            } catch (e: DirectoryIteratorException) {
                throw e.cause ?: e
            }
            // A mount or ancestor may have changed while the listing was being read.
            validateDirectory(dir)
        }
        var comparisons = 0
        entries.sortWith { a, b ->
            if (++comparisons % 512 == 0) checkActive()
            ORDER.compare(a, b)
        }
        checkActive()
        return entries
    }

    /** Re-check a restored or tapped row, which may be stale even when the UI has retained it. */
    fun fileEntry(file: File): LocalEntry {
        checkActive()
        val parent = file.parentFile ?: throw IOException("File has no storage directory")
        val (volume, _) = validateDirectory(parent)
        val path = file.toPath()
        if (protectedStoragePath(path, volume.toPath())) throw AccessDeniedException(file.path)
        val attrs = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
        if (!attrs.isRegularFile) throw IOException("Expected a regular file: " + file.path)
        if (!Files.isReadable(path)) throw AccessDeniedException(file.path)
        validateDirectory(parent)
        return entry(file, attrs)
    }

    private fun validateDirectory(dir: File): Pair<File, Int> {
        val path = dir.toPath()
        if (!path.isAbsolute || path != path.normalize()) throw IOException("Invalid directory: " + dir.path)
        val volume = containingVolume(dir, roots) ?: throw IOException("Storage volume unavailable: " + dir.path)
        val mount = volume.toPath()
        val depth = 1 + path.nameCount - mount.nameCount
        if (depth > limit) throw IOException("Directory exceeds scan depth: " + dir.path)
        if (protectedStoragePath(path, mount)) throw AccessDeniedException(dir.path)

        // Read each component from the mount down. NOFOLLOW_LINKS by itself only covers the final component.
        var current = mount
        for (level in mount.nameCount..path.nameCount) {
            checkActive()
            if (level > mount.nameCount) current = current.resolve(path.getName(level - 1))
            if (!Files.readAttributes(current, BasicFileAttributes::class.java, NOFOLLOW_LINKS).isDirectory) {
                throw NotDirectoryException(current.toString())
            }
        }
        if (!enterable(path)) throw AccessDeniedException(dir.path)
        return volume to depth
    }

    private fun attributesIfPresent(path: Path): BasicFileAttributes? = try {
        Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
    } catch (_: NoSuchFileException) {
        null
    } catch (_: AccessDeniedException) {
        null
    }

    private fun enterable(path: Path) = Files.isReadable(path) && Files.isExecutable(path)

    private fun entry(file: File, attrs: BasicFileAttributes) = LocalEntry(
        file, attrs.isDirectory, if (attrs.isDirectory) DIRECTORY_MIME else mime(file),
        if (attrs.isDirectory) null else attrs.size(), attrs.lastModifiedTime().toMillis(),
    )

    private companion object {
        val ORDER = compareByDescending<LocalEntry> { it.isDirectory }
            .thenBy(String.CASE_INSENSITIVE_ORDER) { it.file.name }
            .thenBy { it.file.name }
            .thenBy { it.file.path }
    }
}
