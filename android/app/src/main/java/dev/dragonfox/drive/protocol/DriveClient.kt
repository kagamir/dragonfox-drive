package dev.dragonfox.drive.protocol

import org.json.JSONArray
import org.json.JSONObject
import java.io.DataInputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.util.Locale

private const val CHUNK_SIZE = 4 * 1024 * 1024

private fun JSONObject.putEncrypted(field: String, sealed: SealedBytes): JSONObject =
    put(field, WireCrypto.b64(sealed.bytes)).put(field + "_nonce", WireCrypto.b64(sealed.iv))

private fun JSONObject.decryptField(field: String, key: ByteArray): ByteArray =
    WireCrypto.open(key, WireCrypto.unb64(getString(field)), WireCrypto.unb64(getString(field + "_nonce")))

private fun JSONArray.objects(): List<JSONObject> = List(length()) { getJSONObject(it) }

private fun digestHex(bytes: ByteArray): String = WireCrypto.hex(MessageDigest.getInstance("SHA-256").digest(bytes))

/** All I/O is blocking. Use a single client per signed-in account on worker threads. */
class DriveClient(session: DriveSession, private val onSession: (DriveSession) -> Unit) {
    @Volatile var session: DriveSession = session
        private set

    private val http = DriveHttp(session.server)
    private val master = WireCrypto.unb64(session.masterKey)
    private val tokenLock = Any()
    private val activeUploads = mutableSetOf<String>() // guarded by tokenLock
    private val folderLock = Any()
    @Volatile private var folderKeys: Map<String, ByteArray> = emptyMap()
    private data class ChunkSource(val key: ByteArray, val iv: ByteArray, val contentId: String, val count: Int, val revision: String)
    @Volatile private var sources: Map<String, ChunkSource> = emptyMap()

    companion object {
        fun login(server: String, username: String, password: String, onSession: (DriveSession) -> Unit): DriveClient {
            val http = DriveHttp(server)
            val body = JSONObject().put("username", username.trim().lowercase(Locale.ROOT))
            val salts = http.post("/api/auth/prelogin", body)
            val key = WireCrypto.passwordKey(password, WireCrypto.unhex(salts.getString("kdf_salt")))
            try {
                val verifier = WireCrypto.verifier(key, WireCrypto.unhex(salts.getString("server_salt")))
                val res = http.post("/api/auth/login", body.put("auth_verifier", WireCrypto.hex(verifier)).put("device_name", "DragonFox Android"))
                return authenticated(http, res, res.decryptField("encrypted_master_key", key), onSession)
            } finally {
                key.fill(0)
            }
        }

        fun register(server: String, username: String, password: String, onSession: (DriveSession) -> Unit): DriveClient {
            val http = DriveHttp(server)
            val salt = WireCrypto.random(16)
            val serverSalt = WireCrypto.random(16)
            val key = WireCrypto.passwordKey(password, salt)
            val master = WireCrypto.random(32)
            try {
                val request = JSONObject()
                    .put("username", username.trim().lowercase(Locale.ROOT))
                    .put("kdf_salt", WireCrypto.hex(salt))
                    .put("server_salt", WireCrypto.hex(serverSalt))
                    .put("auth_verifier", WireCrypto.hex(WireCrypto.verifier(key, serverSalt)))
                    .putEncrypted("encrypted_master_key", WireCrypto.seal(key, master))
                return authenticated(http, http.post("/api/auth/register", request), master, onSession)
            } finally {
                key.fill(0)
                master.fill(0)
            }
        }

        private fun authenticated(http: DriveHttp, res: JSONObject, master: ByteArray, save: (DriveSession) -> Unit): DriveClient {
            require(master.size == 32) { "无效的账户密钥" }
            val tokens = res.getJSONObject("tokens")
            val session = DriveSession(http.base, res.getString("user_id"), res.getString("username"), WireCrypto.b64(master),
                tokens.getString("access_token"), tokens.getString("refresh_token"))
            save(session)
            return DriveClient(session, save)
        }
    }

    private fun request(
        method: String, path: String, body: ByteArray? = null, binary: Boolean = false, onSent: ((Int) -> Unit)? = null
    ): ByteArray {
        val stale = session
        try {
            return http.request(method, path, stale.accessToken, body, binary, onSent)
        } catch (e: StatusException) {
            if (e.status != 401) throw e
        }
        synchronized(tokenLock) {
            if (session.accessToken == stale.accessToken && session.refreshToken == stale.refreshToken) {
                val tokens = http.post("/api/auth/refresh", JSONObject().put("refresh_token", stale.refreshToken))
                session = DriveSession(stale.server, stale.userId, stale.username, stale.masterKey,
                    tokens.getString("access_token"), tokens.getString("refresh_token"), session.pendingUploads)
                onSession(session)
            }
        }
        return http.request(method, path, session.accessToken, body, binary, onSent)
    }

    private fun json(method: String, path: String, payload: JSONObject? = null): JSONObject =
        JSONObject(request(method, path, payload?.toString()?.toByteArray()).decodeToString())

    fun logout() { json("POST", "/api/auth/logout") }

    private fun parentOf(row: JSONObject): String? =
        if (row.isNull("encrypted_parent_id")) null else row.decryptField("encrypted_parent_id", master).decodeToString()

    private fun JSONObject.setParent(parentId: String?): JSONObject {
        if (parentId != null) putEncrypted("encrypted_parent_id", WireCrypto.seal(master, parentId.toByteArray()))
        return this
    }

    private fun keyFor(parentId: String?): ByteArray =
        if (parentId == null) master else folderKeys[parentId] ?: throw IOException("找不到云端目录，请刷新目录后重试")

    fun listFolders(): List<CloudFolder> = synchronized(folderLock) {
        val rows = json("GET", "/api/folders").getJSONArray("folders").objects()
        val children = rows.groupBy(::parentOf)
        val keys = mutableMapOf<String, ByteArray>()
        val folders = mutableListOf<CloudFolder>()
        val queue = ArrayDeque<Pair<String?, ByteArray>>()
        queue.add(null to master)
        while (queue.isNotEmpty()) {
            val (parent, wrappingKey) = queue.removeFirst()
            for (row in children[parent].orEmpty()) {
                val id = row.getString("id")
                val key = row.decryptField("encrypted_folder_key", wrappingKey)
                check(keys.put(id, key) == null) { "云端文件夹 ID 重复" }
                val name = WireCrypto.unpad(row.decryptField("encrypted_name", key)).decodeToString()
                folders += CloudFolder(id, parent, name)
                queue.add(id to key)
            }
        }
        check(folders.size == rows.size) { "云端目录树不完整，请刷新后重试" }
        folderKeys = keys
        folders
    }

    fun createFolder(parentId: String?, name: String): CloudFolder = synchronized(folderLock) {
        require(name.isNotEmpty())
        val key = WireCrypto.random(32)
        val body = JSONObject().setParent(parentId)
            .putEncrypted("encrypted_folder_key", WireCrypto.seal(keyFor(parentId), key))
            .putEncrypted("encrypted_name", WireCrypto.seal(key, WireCrypto.pad(name.toByteArray(), 32)))
        val id = json("POST", "/api/folders", body).getString("id")
        folderKeys = folderKeys + (id to key)
        CloudFolder(id, parentId, name)
    }

    private fun rememberUpload(id: String) = synchronized(tokenLock) {
        activeUploads.add(id)
        session = session.withPending(session.pendingUploads + id)
        onSession(session)
    }

    private fun forgetUploads(ids: Set<String>) = synchronized(tokenLock) {
        val pending = session.pendingUploads - ids
        if (pending != session.pendingUploads) {
            session = session.withPending(pending)
            onSession(session)
        }
    }

    // Only act on slots this installation created. Other devices may have live uploads.
    private fun recoverInterruptedUploads(previous: Set<String>, rows: JSONArray) {
        if (previous.isEmpty()) return
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            val id = row.getString("id")
            if (id in previous && row.getString("status") in setOf("pending", "uploading")) {
                try {
                    json("DELETE", "/api/files/" + id)
                } catch (e: StatusException) {
                    if (e.status != 404) throw e
                }
            }
        }
        forgetUploads(previous)
    }

    /** Refresh listFolders first so a file wrapped under a nested folder can be decrypted. */
    fun listFiles(): List<CloudFile> {
        val previous = synchronized(tokenLock) { session.pendingUploads - activeUploads }
        val rows = json("GET", "/api/files").getJSONArray("files")
        recoverInterruptedUploads(previous, rows)
        val missingDigests = mutableMapOf<String, ChunkSource>()
        val result = mutableListOf<CloudFile>()
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            if (row.getString("status") != "ready") continue
            val id = row.getString("id")
            val parent = parentOf(row)
            val fileKey = row.decryptField("encrypted_file_key", keyFor(parent))
            val encrypted = WireCrypto.unb64(row.getString("encrypted_manifest"))
            val manifest = JSONObject(WireCrypto.unpad(WireCrypto.open(fileKey, encrypted,
                WireCrypto.unb64(row.getString("encrypted_manifest_nonce")))).decodeToString())
            val revision = digestHex(encrypted)
            val digest = manifest.optString("plaintext_sha256", "").takeIf { it.isNotEmpty() }
            if (digest == null) {
                missingDigests[id] = ChunkSource(fileKey, WireCrypto.unb64(manifest.getString("iv_base")),
                    manifest.getString("content_id"), row.getInt("chunk_count"), revision)
            }
            result += CloudFile(id, parent, manifest.getString("name"), manifest.getLong("size"), digest, revision)
        }
        sources = missingDigests
        return result
    }

    /** Older browser uploads omit the digest. Download only when sync needs to resolve a name + size collision. */
    fun contentSha256(file: CloudFile, onChunk: () -> Unit): String {
        file.sha256?.let { return it }
        val source = sources[file.id]?.takeIf { it.revision == file.revision }
            ?: throw IOException("文件已变更，请重新扫描")
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        repeat(source.count) { index ->
            onChunk()
            val bytes = request("GET", "/api/files/" + file.id + "/chunks/" + index)
            val plain = WireCrypto.openChunk(source.key, source.iv, index, source.contentId, bytes)
            digest.update(plain)
            size += plain.size
        }
        check(size == file.size) { "云端文件长度与清单不一致" }
        return WireCrypto.hex(digest.digest())
    }

    fun upload(parentId: String?, file: File, mime: String, onProgress: (Long) -> Unit): CloudFile {
        require(file.isFile) { "找不到本地文件" }
        val size = file.length()
        val modified = file.lastModified()
        val count = if (size == 0L) 1L else (size - 1) / CHUNK_SIZE + 1
        require(count <= Int.MAX_VALUE) { "文件超过分块数量限制" }
        val key = WireCrypto.random(32)
        val ivBase = WireCrypto.random(12)
        val contentId = WireCrypto.hex(WireCrypto.random(16))
        val create = JSONObject().setParent(parentId).put("total_size", size).put("chunk_count", count)
            .putEncrypted("encrypted_file_key", WireCrypto.seal(keyFor(parentId), key))
        onProgress(0)
        val id = json("POST", "/api/files", create).getString("id")
        val path = "/api/files/" + id
        var finalizing = false
        try {
            rememberUpload(id)
            var done = 0L
            val digest = MessageDigest.getInstance("SHA-256")
            DataInputStream(file.inputStream()).use { input ->
                repeat(count.toInt()) { index ->
                    onProgress(done)
                    val plain = ByteArray(minOf(CHUNK_SIZE.toLong(), size - done).toInt())
                    input.readFully(plain)
                    digest.update(plain)
                    val cipher = WireCrypto.chunk(key, ivBase, index, contentId, plain)
                    var sent = 0
                    request("PUT", path + "/chunks/" + index, cipher, binary = true) { bytes ->
                        sent = maxOf(sent, minOf(plain.size, bytes))
                        onProgress(done + sent)
                    }
                    done += plain.size
                }
                check(input.read() == -1 && file.length() == size && file.lastModified() == modified) {
                    "本地文件在上传期间发生变化，将在下一次同步重试"
                }
            }
            val hash = WireCrypto.hex(digest.digest())
            val manifest = JSONObject().put("version", 1).put("name", file.name)
                .put("mime", mime.ifBlank { "application/octet-stream" }).put("size", size)
                .put("chunk_size", CHUNK_SIZE).put("iv_base", WireCrypto.b64(ivBase))
                .put("content_id", contentId).put("plaintext_sha256", hash).put("created_at", Instant.now().toString())
            val sealed = WireCrypto.seal(key, WireCrypto.pad(manifest.toString().toByteArray(), 256))
            json("PUT", path + "/manifest", JSONObject().putEncrypted("encrypted_manifest", sealed))
            onProgress(size)
            finalizing = true
            json("POST", path + "/finalize")
            forgetUploads(setOf(id))
            return CloudFile(id, parentId, file.name, size, hash, digestHex(sealed.bytes))
        } catch (e: Exception) {
            // A lost finalize response may refer to a committed file; reconciliation will find it by its digest.
            if (!finalizing) runCatching {
                json("DELETE", path)
                forgetUploads(setOf(id))
            }
            throw e
        } finally {
            synchronized(tokenLock) { activeUploads.remove(id) }
            key.fill(0)
        }
    }
}
