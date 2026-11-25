package dev.dragonfox.drive.sync

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.Settings
import android.webkit.MimeTypeMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.file.AccessDeniedException

object FileAccess {
    @Suppress("UNUSED_PARAMETER")
    fun granted(context: Context): Boolean = Environment.isExternalStorageManager()

    fun requestIntent(context: Context): Intent {
        val specific = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.fromParts("package", context.packageName, null))
        return if (specific.resolveActivity(context.packageManager) != null) specific
               else Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
    }
}

class FolderScanner(private val context: Context, private val rootsOverride: List<File>? = null) {
    internal fun volumes(): List<VolumeRoot> =
        rootsOverride?.map { VolumeRoot(it, emptyList()) } ?: context.getSystemService(StorageManager::class.java).storageVolumes.mapNotNull { volume ->
            val dir = volume.directory ?: return@mapNotNull null
            VolumeRoot(dir, if (volume.isPrimary) emptyList() else listOf(volume.uuid ?: dir.name))
        }

    fun roots(): List<File> = volumes().map { it.dir }

    fun volumeDepth(directory: File): Int? = storageDepth(directory, roots())

    internal suspend fun directoryEntries(dir: File?, maxDepth: Int): List<LocalEntry> =
        readLocal(maxDepth) { entries(dir) }

    internal suspend fun fileEntry(file: File, maxDepth: Int): LocalEntry =
        readLocal(maxDepth) { this.fileEntry(file) }

    private suspend fun <T> readLocal(maxDepth: Int, read: LocalDirectoryListing.() -> T): T =
        withContext(Dispatchers.IO) {
            val job = currentCoroutineContext()
            job.ensureActive()
            if (!FileAccess.granted(context)) throw SecurityException("All files access required")
            try {
                LocalDirectoryListing(roots(), maxDepth, ::mime) { job.ensureActive() }.read()
            } catch (e: AccessDeniedException) {
                throw SecurityException(e.localizedMessage, e)
            }
        }

    internal fun accessible(dir: File, volumes: List<VolumeRoot>): Boolean {
        val root = volumes.filter { dir.toPath().startsWith(it.dir.toPath()) }
            .maxByOrNull { it.dir.path.length } ?: return false
        return !protectedStoragePath(dir.toPath(), root.dir.toPath())
    }

    internal fun mime(file: File): String = fileMime(file) { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }

    private fun isMedia(file: File) = SyncMode.MEDIA.accepts(mime(file))

    internal suspend fun mediaBuckets(maxDepth: Int): List<MediaBucket> = withContext(Dispatchers.IO) {
        val job = currentCoroutineContext()
        val volumes = volumes()
        val created = MediaCreatedTimes(context)
        collectAlbums(volumes, maxDepth, { accessible(it, volumes) }, ::isMedia, created::read) { job.ensureActive() }
    }
}
