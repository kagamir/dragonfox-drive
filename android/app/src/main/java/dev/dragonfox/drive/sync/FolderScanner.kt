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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.nio.file.Files

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
    private val pageLock = Mutex()
    private var cursor: AlbumCursor? = null
    internal fun volumes(): List<VolumeRoot> =
        rootsOverride?.map { VolumeRoot(it, emptyList()) } ?: context.getSystemService(StorageManager::class.java).storageVolumes.mapNotNull { volume ->
            val dir = volume.directory ?: return@mapNotNull null
            if (!dir.isDirectory) return@mapNotNull null
            VolumeRoot(dir, if (volume.isPrimary) emptyList() else listOf(volume.uuid ?: dir.name))
        }

    fun roots(): List<File> = volumes().map { it.dir }

    fun volumeDepth(directory: File): Int? = storageDepth(directory, roots())

    fun children(dir: File): List<File> {
        val volumes = volumes()
        return dir.listFiles().orEmpty().filter {
            it.isDirectory && !Files.isSymbolicLink(it.toPath()) && accessible(it, volumes)
        }.sortedBy { it.name.lowercase() }
    }

    internal fun accessible(dir: File, volumes: List<VolumeRoot>): Boolean = volumes.any { volume ->
        dir.toPath().startsWith(volume.dir.toPath()) &&
            listOf("Android/data", "Android/obb").none { dir.toPath().startsWith(File(volume.dir, it).toPath()) }
    }

    internal fun mime(file: File): String = fileMime(file) { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }

    private fun isMedia(file: File) = SyncMode.MEDIA.accepts(mime(file))

    suspend fun mediaBuckets(maxDepth: Int): List<MediaBucket> = withContext(Dispatchers.IO) {
        pageLock.withLock { cursor = null }
        val job = currentCoroutineContext()
        val volumes = volumes()
        collectAlbums(volumes, maxDepth, { accessible(it, volumes) }, ::isMedia) { job.ensureActive() }
    }

    suspend fun mediaPage(bucket: MediaBucket, offset: Int, limit: Int): List<File> = withContext(Dispatchers.IO) {
        val job = currentCoroutineContext()
        pageLock.withLock {
            val volumes = volumes()
            val current = cursor?.takeIf { it.bucket == bucket && offset != 0 } ?: AlbumCursor(bucket, volumes.map { it.dir },
                { accessible(it, volumes) }, ::isMedia).also { cursor = it }
            try {
                current.page(offset, limit) { job.ensureActive() }
            } catch (e: Exception) {
                // A sequence aborted mid-directory cannot safely resume.
                cursor = null
                throw e
            }
        }
    }
}
