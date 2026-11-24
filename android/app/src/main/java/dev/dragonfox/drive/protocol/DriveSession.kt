package dev.dragonfox.drive.protocol

/** Store this entire record encrypted using the Android Keystore. */
class DriveSession(
    val server: String,
    val userId: String,
    val username: String,
    val masterKey: String,
    val accessToken: String,
    val refreshToken: String,
    val pendingUploads: Set<String> = emptySet()
) {
    internal fun withPending(ids: Set<String>) = DriveSession(server, userId, username, masterKey, accessToken, refreshToken, ids)
}

enum class FolderType(val wire: String?) { AUTO(null), NORMAL("normal"), PHOTOS("photos") }

data class CloudFolder(val id: String, val parentId: String?, val name: String, val type: FolderType = FolderType.AUTO)

data class CloudFile(
    val id: String, val parentId: String?, val name: String, val size: Long,
    val sha256: String? = null, val revision: String = "", val mime: String = "", val createdAt: String? = null
) {
    val isImage: Boolean get() {
        val type = mime.substringBefore(';').trim().lowercase()
        if (type.isNotEmpty() && type != "application/octet-stream" && type != "binary/octet-stream") {
            return type.startsWith("image/")
        }
        return name.substringAfterLast('.', "").lowercase() in imageExtensions
    }
}

private val imageExtensions = setOf("apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jfif", "jpeg",
    "jpg", "jxl", "png", "svg", "tif", "tiff", "webp", "dng", "arw", "cr2", "cr3", "nef", "raf", "rw2", "orf")

/** Pass the ready files immediately inside a non-root folder. */
fun shouldShowPhotos(type: FolderType, files: List<CloudFile>): Boolean = when (type) {
    FolderType.PHOTOS -> true
    FolderType.NORMAL -> false
    FolderType.AUTO -> files.count { it.isImage } > files.size / 2
}
