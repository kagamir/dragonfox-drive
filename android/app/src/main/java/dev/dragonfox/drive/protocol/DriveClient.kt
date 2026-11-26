package dev.dragonfox.drive.protocol

import org.json.JSONArray
import org.json.JSONObject
import java.io.DataInputStream
import java.io.File
import java.io.InputStream
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

private const val CHUNK_SIZE = 4 * 1024 * 1024

private fun JSONObject.putEncrypted(field: String, sealed: SealedBytes): JSONObject =
    put(field, WireCrypto.b64(sealed.bytes)).put(field + "_nonce", WireCrypto.b64(sealed.iv))

private fun JSONObject.decryptField(field: String, key: ByteArray): ByteArray =
    WireCrypto.open(key, WireCrypto.unb64(getString(field)), WireCrypto.unb64(getString(field + "_nonce")))

private fun JSONArray.objects(): List<JSONObject> = List(length()) { getJSONObject(it) }

private fun digestHex(bytes: ByteArray): String = WireCrypto.hex(MessageDigest.getInstance("SHA-256").digest(bytes))

internal data class FileMaterial(val key: ByteArray, val row: JSONObject, val manifest: JSONObject)

/** All I/O is blocking. Use a single client per signed-in account on worker threads. */
class DriveClient(session: DriveSession, private val onSession: (DriveSession) -> Unit) {
    @Volatile var session: DriveSession = session
        private set

    private val http = DriveHttp(session.server)
    private val master = WireCrypto.unb64(session.masterKey)
    private val tokenLock = Any()
    private val activeUploads = mutableSetOf<String>() // guarded by tokenLock
    // Protect the local tree/key snapshot and serialize metadata changes with upload slot creation.
    // Chunk transfers can still run in parallel.
    private val folderLock = Any()
    private var folderSnapshot: String? = null
    private var folderInventoryCurrent = false
    private val fileChanges = AtomicLong()
    @Volatile private var folderKeys: Map<String, ByteArray> = emptyMap()
    private data class ChunkSource(val key: ByteArray, val iv: ByteArray, val contentId: String, val count: Int, val revision: String)
    @Volatile private var sources = ConcurrentHashMap<String, ChunkSource>()

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
        method: String, path: String, body: ByteArray? = null, binary: Boolean = false, expectedBytes: Int? = null, checkRead: (() -> Unit)? = null, onSent: ((Int) -> Unit)? = null
    ): ByteArray {
        val stale = session
        try {
            return http.request(method, path, stale.accessToken, body, binary, expectedBytes, checkRead, onSent)
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
        return http.request(method, path, session.accessToken, body, binary, expectedBytes, checkRead, onSent)
    }

    internal fun json(method: String, path: String, payload: JSONObject? = null): JSONObject {
        val result = JSONObject(request(method, path, payload?.toString()?.toByteArray()).decodeToString())
        if (method != "GET" && (path.startsWith("/api/files") || method == "DELETE" && path.startsWith("/api/folders/"))) {
            fileChanges.incrementAndGet()
        }
        return result
    }

    fun logout() { json("POST", "/api/auth/logout") }

    private fun parentOf(row: JSONObject): String? =
        if (row.isNull("encrypted_parent_id")) null else row.decryptField("encrypted_parent_id", master).decodeToString()

    private fun JSONObject.setParent(parentId: String?): JSONObject {
        if (parentId == null) put("encrypted_parent_id", JSONObject.NULL).put("encrypted_parent_id_nonce", JSONObject.NULL)
        else putEncrypted("encrypted_parent_id", WireCrypto.seal(master, parentId.toByteArray()))
        return this
    }

    private fun keyFor(parentId: String?): ByteArray =
        if (parentId == null) master else folderKeys[parentId] ?: throw IOException("找不到云端目录，请刷新目录后重试")

    fun listFolders(): List<CloudFolder> = synchronized(folderLock) {
        val response = json("GET", "/api/folders")
        val rows = response.getJSONArray("folders").objects()
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
                // Type is optional. An unreadable override must not block older clients' sync data.
                val type = if (row.isNull("encrypted_type")) FolderType.AUTO else try {
                    val wire = row.decryptField("encrypted_type", key).decodeToString()
                    FolderType.entries.firstOrNull { it.wire == wire } ?: FolderType.AUTO
                } catch (_: Exception) { FolderType.AUTO }
                folders += CloudFolder(id, parent, name, type)
                queue.add(id to key)
            }
        }
        check(folders.size == rows.size) { "云端目录树不完整，请刷新后重试" }
        folderKeys = keys
        folderInventoryCurrent = true
        folderSnapshot = response.optString("snapshot", "").takeIf { it.isNotEmpty() }
        folders
    }

    fun setFolderType(id: String, type: FolderType): Unit = synchronized(folderLock) {
        require(id.isNotBlank()) { "Root folder has no type override" }
        val body = JSONObject()
        val wire = type.wire
        if (wire == null) {
            body.put("encrypted_type", JSONObject.NULL).put("encrypted_type_nonce", JSONObject.NULL)
        } else {
            body.putEncrypted("encrypted_type", WireCrypto.seal(keyFor(id), wire.toByteArray(Charsets.UTF_8)))
        }
        val result = json("PATCH", "/api/folders/$id", body)
        if (!result.optBoolean("folder_type_updated", false)) throw IOException("Server does not support folder types")
        folderInventoryCurrent = false
    }

    // Called with folderLock held. Only a rejected snapshot may be retried: a lost response
    // from a successful POST is ambiguous and must never create a duplicate object.
    private fun createIn(parentId: String?, path: String, payload: (ByteArray) -> JSONObject): JSONObject {
        if (parentId != null && (!folderInventoryCurrent || parentId !in folderKeys)) listFolders()
        fun send(): JSONObject {
            val body = payload(keyFor(parentId)).setParent(parentId)
            if (parentId != null) folderSnapshot?.let { body.put("expected_folder_snapshot", it) }
            return json("POST", path, body)
        }
        return try {
            send()
        } catch (e: StatusException) {
            if (e.status != 409 || parentId == null || folderSnapshot == null) throw e
            listFolders()
            send()
        }
    }

    fun createFolder(parentId: String?, name: String): CloudFolder = synchronized(folderLock) {
        require(name.isNotEmpty())
        val key = WireCrypto.random(32)
        val id = createIn(parentId, "/api/folders") { parentKey ->
            JSONObject().putEncrypted("encrypted_folder_key", WireCrypto.seal(parentKey, key))
                .putEncrypted("encrypted_name", WireCrypto.seal(key, WireCrypto.pad(name.toByteArray(), 32)))
        }.getString("id")
        folderInventoryCurrent = false
        folderKeys = folderKeys + (id to key)
        CloudFolder(id, parentId, name)
    }

    fun renameFolder(id: String, newName: String) {
        require(newName.isNotBlank())
        synchronized(folderLock) {
            if (id !in folderKeys) listFolders()
            val name = WireCrypto.seal(keyFor(id), WireCrypto.pad(newName.toByteArray(), 32))
            json("PATCH", "/api/folders/$id", JSONObject().putEncrypted("encrypted_name", name))
            folderInventoryCurrent = false
        }
    }

    fun moveFolder(id: String, newParentId: String?) {
        synchronized(folderLock) {
            val tree = listFolders().associateBy { it.id }
            val folder = tree[id] ?: throw IOException("Folder no longer exists")
            var destination = newParentId
            while (destination != null) {
                require(destination != id) { "Cannot move a folder into itself or a descendant" }
                destination = (tree[destination] ?: throw IOException("Destination folder no longer exists")).parentId
            }
            if (folder.parentId == newParentId) return
            val body = JSONObject().setParent(newParentId)
                .putEncrypted("encrypted_folder_key", WireCrypto.seal(keyFor(newParentId), keyFor(id)))
            folderSnapshot?.let { body.put("expected_folder_snapshot", it) }
            json("PATCH", "/api/folders/$id", body)
            folderInventoryCurrent = false
        }
    }

    fun deleteFolder(id: String) {
        synchronized(folderLock) {
            val folders = listFolders()
            if (id !in folderKeys) throw IOException("Folder no longer exists")
            val children = folders.groupBy { it.parentId }
            val subtree = mutableSetOf<String>()
            val queue = ArrayDeque(listOf(id))
            while (queue.isNotEmpty()) {
                val current = queue.removeFirst()
                subtree.add(current)
                for (child in children[current].orEmpty()) queue.add(child.id)
            }
            val response = json("GET", "/api/files")
            val files = response.getJSONArray("files").objects().filter { parentOf(it) in subtree }
            val ids = files.map { it.getString("id") }
            // The delete payload must include pending slots too. An active local transfer
            // owns its slot until finalize or cleanup; let the user retry when it finishes.
            if (synchronized(tokenLock) { ids.any { it in activeUploads } }) {
                throw IOException("Folder contains an active upload")
            }
            val body = JSONObject().put("folder_ids", JSONArray(subtree)).put("file_ids", JSONArray(ids))
            folderSnapshot?.let { body.put("expected_folder_snapshot", it) }
            response.optString("snapshot", "").takeIf { it.isNotEmpty() }?.let { body.put("expected_file_snapshot", it) }
            json("DELETE", "/api/folders/$id", body)
            folderKeys = folderKeys - subtree
            folderInventoryCurrent = false
            ids.forEach { sources.remove(it) }
        }
    }

    private fun rememberUpload(id: String) = synchronized(tokenLock) {
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

    private fun chunkSource(key: ByteArray, row: JSONObject, manifest: JSONObject, revision: String): ChunkSource =
        ChunkSource(key, WireCrypto.unb64(manifest.getString("iv_base")), manifest.getString("content_id"),
            row.getInt("chunk_count"), revision)

    /** Refresh listFolders first so a file wrapped under a nested folder can be decrypted. */
    fun listFiles(): List<CloudFile> {
        fun fetch(): Pair<Set<String>, JSONArray> {
            // A slot must already have been inactive when this server snapshot was requested.
            // Its finalize response can be lost while the listing is in flight.
            val inactive = synchronized(tokenLock) { session.pendingUploads - activeUploads }
            return inactive to json("GET", "/api/files").getJSONArray("files")
        }
        val generation = fileChanges.get()
        val snapshot = fetch()
        return synchronized(folderLock) {
            val (inactive, rows) = if (fileChanges.get() == generation) snapshot else fetch()
            recoverInterruptedUploads(inactive, rows)
            decodeFiles(rows)
        }
    }

    private fun decodeFiles(rows: JSONArray): List<CloudFile> {
        val readableFiles = ConcurrentHashMap<String, ChunkSource>()
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
            val file = CloudFile(id, parent, manifest.getString("name"), manifest.getLong("size"), digest, revision,
                manifest.optString("mime", ""), manifest.optString("created_at", "").takeIf { it.isNotBlank() })
            readableFiles[id] = chunkSource(fileKey, row, manifest, revision)
            result += file
        }
        sources = readableFiles
        return result
    }

    private fun loadMaterial(id: String, expectedRevision: String? = null): FileMaterial {
        val row = json("GET", "/api/files").getJSONArray("files").objects().firstOrNull { it.getString("id") == id }
            ?: throw IOException("File no longer exists")
        if (row.getString("status") != "ready") throw IOException("File is not ready")
        val parent = parentOf(row)
        if (parent != null && parent !in folderKeys) listFolders()
        val key = row.decryptField("encrypted_file_key", keyFor(parent))
        val ciphertext = WireCrypto.unb64(row.getString("encrypted_manifest"))
        if (!expectedRevision.isNullOrEmpty() && expectedRevision != digestHex(ciphertext)) {
            throw StatusException(409, "File has changed. Refresh and retry.")
        }
        val bytes = WireCrypto.open(key, ciphertext, WireCrypto.unb64(row.getString("encrypted_manifest_nonce")))
        return FileMaterial(key, row, JSONObject(WireCrypto.unpad(bytes).decodeToString()))
    }

    internal fun fileMaterial(file: CloudFile): FileMaterial = synchronized(folderLock) {
        loadMaterial(file.id, file.revision)
    }

    fun renameFile(id: String, newName: String) {
        require(newName.isNotBlank())
        synchronized(folderLock) {
            val (key, row, manifest) = loadMaterial(id)
            val plain = manifest.put("name", newName).toString().toByteArray()
            val sealed = WireCrypto.seal(key, WireCrypto.pad(plain, 256))
            val body = JSONObject().putEncrypted("encrypted_manifest", sealed)
                .put("expected_updated_at", row.getString("updated_at"))
            json("PUT", "/api/files/$id/manifest", body)
            sources[id] = chunkSource(key, row, manifest, digestHex(sealed.bytes))
        }
    }

    fun moveFile(id: String, newParentId: String?) {
        synchronized(folderLock) {
            listFolders()
            val (key, row) = loadMaterial(id)
            if (parentOf(row) == newParentId) return
            val body = JSONObject().setParent(newParentId)
                .putEncrypted("encrypted_file_key", WireCrypto.seal(keyFor(newParentId), key))
                .put("expected_updated_at", row.getString("updated_at"))
            if (newParentId != null) folderSnapshot?.let { body.put("expected_folder_snapshot", it) }
            json("PATCH", "/api/files/$id", body)
        }
    }

    fun deleteFile(id: String) {
        synchronized(folderLock) {
            json("DELETE", "/api/files/$id")
            sources.remove(id)
        }
    }

    /** Older browser uploads omit the digest. Download only when sync needs to resolve a name + size collision. */
    fun contentSha256(file: CloudFile, onChunk: () -> Unit): String {
        file.sha256?.let { return it }
        val digest = MessageDigest.getInstance("SHA-256")
        readFile(file, onChunk) { bytes -> digest.update(bytes); true }
        return WireCrypto.hex(digest.digest())
    }

    /** Stop after an authenticated chunk if the consumer has enough bytes for an embedded thumbnail. */
    fun readFile(file: CloudFile, checkActive: () -> Unit, consume: (ByteArray) -> Boolean) {
        val source = sources[file.id]?.takeIf { it.revision == file.revision }
            ?: throw IOException("文件已变更，请重新扫描")
        require(file.size >= 0)
        val expectedCount = if (file.size == 0L) 1L else (file.size - 1) / CHUNK_SIZE + 1
        check(source.count.toLong() == expectedCount) { "Invalid encrypted chunk count" }
        var size = 0L
        repeat(source.count) { index ->
            checkActive()
            val expectedLength = minOf(file.size - size, CHUNK_SIZE.toLong()).toInt() + 16
            val cipher = request("GET", "/api/files/${file.id}/chunks/$index", expectedBytes = expectedLength, checkRead = checkActive)
            val plain = WireCrypto.openChunk(source.key, source.iv, index, source.contentId, cipher)
            size += plain.size
            check(size <= file.size) { "云端文件长度与清单不一致" }
            checkActive()
            if (!consume(plain)) return
        }
        check(size == file.size) { "云端文件长度与清单不一致" }
    }

    fun upload(parentId: String?, file: File, mime: String, onProgress: (Long) -> Unit): CloudFile {
        require(file.isFile) { "找不到本地文件" }
        val size = file.length()
        val modified = file.lastModified()
        return uploadStream(parentId, file.name, size, mime, { file.inputStream() }, onProgress) {
            check(file.length() == size && file.lastModified() == modified) { "本地文件在上传期间发生变化，将在下一次同步重试" }
        }
    }

    fun createTextFile(parentId: String?, name: String, text: String = ""): CloudFile {
        require(name.isNotBlank())
        val bytes = text.toByteArray()
        return uploadStream(parentId, name, bytes.size.toLong(), "text/plain", { bytes.inputStream() }, {})
    }

    fun uploadStream(parentId: String?, name: String, size: Long, mime: String,
        open: () -> InputStream, onProgress: (Long) -> Unit): CloudFile =
        uploadStream(parentId, name, size, mime, open, onProgress) {}

    private fun uploadStream(parentId: String?, name: String, size: Long, mime: String,
        open: () -> InputStream, onProgress: (Long) -> Unit, verifySource: () -> Unit): CloudFile {
        require(size >= 0 && name.isNotEmpty())
        val count = if (size == 0L) 1L else (size - 1) / CHUNK_SIZE + 1
        require(count <= Int.MAX_VALUE) { "文件超过分块数量限制" }
        val key = WireCrypto.random(32)
        val ivBase = WireCrypto.random(12)
        val contentId = WireCrypto.hex(WireCrypto.random(16))
        onProgress(0)
        val id = synchronized(folderLock) {
            val createdId = createIn(parentId, "/api/files") { parentKey ->
                JSONObject().put("total_size", size).put("chunk_count", count)
                    .putEncrypted("encrypted_file_key", WireCrypto.seal(parentKey, key))
            }.getString("id")
            synchronized(tokenLock) { activeUploads.add(createdId) }
            createdId
        }
        val path = "/api/files/" + id
        var finalizing = false
        try {
            rememberUpload(id)
            var done = 0L
            val digest = MessageDigest.getInstance("SHA-256")
            DataInputStream(open()).use { input ->
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
                check(input.read() == -1) { "Upload source size changed" }
                verifySource()
            }
            val hash = WireCrypto.hex(digest.digest())
            val manifest = JSONObject().put("version", 1).put("name", name)
                .put("mime", mime.ifBlank { "application/octet-stream" }).put("size", size)
                .put("chunk_size", CHUNK_SIZE).put("iv_base", WireCrypto.b64(ivBase))
                .put("content_id", contentId).put("plaintext_sha256", hash).put("created_at", Instant.now().toString())
            val sealed = WireCrypto.seal(key, WireCrypto.pad(manifest.toString().toByteArray(), 256))
            json("PUT", path + "/manifest", JSONObject().putEncrypted("encrypted_manifest", sealed))
            onProgress(size)
            val revision = digestHex(sealed.bytes)
            synchronized(folderLock) {
                finalizing = true
                json("POST", path + "/finalize")
                sources[id] = ChunkSource(key.copyOf(), ivBase, contentId, count.toInt(), revision)
            }
            forgetUploads(setOf(id))
            return CloudFile(id, parentId, name, size, hash, revision,
                manifest.getString("mime"), manifest.getString("created_at"))
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
