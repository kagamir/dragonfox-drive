package dev.dragonfox.drive.protocol

import org.json.JSONObject
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

internal const val HOME_TEXT_LIMIT = 2 * 1024 * 1024

internal class HomeTextDocument(val file: CloudFile, val updatedAt: String, val text: String)

internal fun DriveClient.openHomeText(file: CloudFile): HomeTextDocument {
    require(file.size in 0..HOME_TEXT_LIMIT.toLong())
    val material = fileMaterial(file)
    require(material.row.getInt("chunk_count") == 1)
    var text: String? = null
    readFile(file, {}) { bytes ->
        require(bytes.size.toLong() == file.size)
        text = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
        false
    }
    return HomeTextDocument(file, material.row.getString("updated_at"), checkNotNull(text))
}

internal fun DriveClient.saveHomeText(document: HomeTextDocument, text: String) {
    val plain = text.toByteArray(Charsets.UTF_8)
    require(plain.size in 1..HOME_TEXT_LIMIT)
    val material = fileMaterial(document.file)
    val row = material.row
    if (row.getString("updated_at") != document.updatedAt) throw StatusException(409, "File changed")
    val iv = WireCrypto.random(12)
    val contentId = WireCrypto.hex(WireCrypto.random(16))
    val manifest = material.manifest
    manifest.put("size", plain.size).put("iv_base", WireCrypto.b64(iv)).put("content_id", contentId)
        .put("plaintext_sha256", WireCrypto.hex(MessageDigest.getInstance("SHA-256").digest(plain)))
    val encrypted = WireCrypto.seal(material.key, WireCrypto.pad(manifest.toString().toByteArray(), 256))
    val body = JSONObject().put("expected_updated_at", document.updatedAt)
        .put("total_size", plain.size)
        .put("encrypted_file_key", row.getString("encrypted_file_key"))
        .put("encrypted_file_key_nonce", row.getString("encrypted_file_key_nonce"))
        .put("encrypted_manifest", WireCrypto.b64(encrypted.bytes))
        .put("encrypted_manifest_nonce", WireCrypto.b64(encrypted.iv))
        .put("chunk", WireCrypto.b64(WireCrypto.chunk(material.key, iv, 0, contentId, plain)))
    json("PUT", "/api/files/${document.file.id}/content", body)
}

internal fun shareWrappingKey(secret: ByteArray, salt: ByteArray): ByteArray {
    require(salt.size == 16)
    // The browser feeds libsodium's URLSAFE_NO_PADDING encoding of these bytes to Argon2id.
    return WireCrypto.passwordKey(Base64.getUrlEncoder().withoutPadding().encodeToString(secret), salt)
}

internal fun DriveClient.createHomeShare(file: CloudFile, password: String?, expiresAt: Instant?, openLimit: Int?): String {
    require(password == null || password.isNotBlank())
    require(expiresAt == null || expiresAt.isAfter(Instant.now()))
    require(openLimit == null || openLimit > 0)
    val material = fileMaterial(file)
    val salt = WireCrypto.random(16)
    val secret = password?.toByteArray(Charsets.UTF_8) ?: WireCrypto.random(32)
    val wrappingKey = shareWrappingKey(secret, salt)
    try {
        val wrapped = WireCrypto.seal(wrappingKey, material.key)
        val body = JSONObject().put("file_id", file.id)
            .put("share_salt", WireCrypto.b64(salt)).put("encrypted_file_key", WireCrypto.b64(wrapped.bytes))
            .put("encrypted_file_key_nonce", WireCrypto.b64(wrapped.iv))
        if (expiresAt != null) body.put("expires_at", expiresAt.toString())
        if (openLimit != null) body.put("download_limit", openLimit)
        if (password != null) body.put("password_hash", WireCrypto.hex(MessageDigest.getInstance("SHA-256").digest(wrappingKey)))
        val id = json("POST", "/api/shares", body).getString("id")
        val base = session.server.trimEnd('/') + "/#/s/" + URLEncoder.encode(id, "UTF-8")
        // URLSearchParams treats a literal "+" as a space. Encode the standard base64 fragment value.
        return if (password != null) base else base + "?k=" + URLEncoder.encode(WireCrypto.b64(secret), "UTF-8")
    } finally {
        secret.fill(0)
        wrappingKey.fill(0)
    }
}
