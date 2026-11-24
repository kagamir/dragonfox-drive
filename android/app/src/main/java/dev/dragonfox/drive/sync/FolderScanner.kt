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

class FolderScanner(private val context: Context) {
    internal fun volumes(): List<VolumeRoot> =
        context.getSystemService(StorageManager::class.java).storageVolumes.mapNotNull { volume ->
            val dir = volume.directory ?: return@mapNotNull null
            if (!dir.isDirectory) return@mapNotNull null
            VolumeRoot(dir, if (volume.isPrimary) emptyList() else listOf(volume.uuid ?: dir.name))
        }

    fun roots(): List<File> = volumes().map { it.dir }

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

    suspend fun mediaFolders(): List<File> = withContext(Dispatchers.IO) {
        val job = currentCoroutineContext()
        val volumes = volumes()
        val result = mutableSetOf<File>()
        for (file in walkFiles(volumes.map { it.dir }, { accessible(it, volumes) }, { job.ensureActive() })) {
            if (SyncMode.MEDIA.accepts(mime(file))) file.parentFile?.let(result::add)
        }
        result.sortedBy { it.path.lowercase() }
    }
}
