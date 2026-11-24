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

data class CloudFolder(val id: String, val parentId: String?, val name: String)

data class CloudFile(
    val id: String, val parentId: String?, val name: String, val size: Long,
    val sha256: String? = null, val revision: String = ""
)
