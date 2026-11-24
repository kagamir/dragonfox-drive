package dev.dragonfox.drive.protocol

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.Locale

class StatusException(val status: Int, message: String) : IOException(message)

internal class DriveHttp(address: String) {
    val base: String

    init {
        val uri = URI(address.trim()).normalize()
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        val host = uri.host?.lowercase(Locale.ROOT)
        require(!host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
            "请输入完整的服务器地址"
        }
        require(scheme == "https" || (scheme == "http" && host in setOf("localhost", "127.0.0.1", "[::1]"))) {
            "服务器需要使用 HTTPS（本机回环地址可使用 HTTP）"
        }
        base = uri.toASCIIString().trimEnd('/')
    }

    fun request(
        method: String, path: String, token: String? = null, body: ByteArray? = null,
        binary: Boolean = false, onSent: ((Int) -> Unit)? = null
    ): ByteArray {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = method
            connection.connectTimeout = 15_000
            connection.readTimeout = 60_000
            connection.useCaches = false
            connection.setRequestProperty("User-Agent", "DragonFox Drive Android")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", if (binary) "application/octet-stream" else "application/json")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { output ->
                    var offset = 0
                    while (offset < body.size) {
                        val count = minOf(64 * 1024, body.size - offset)
                        output.write(body, offset, count)
                        offset += count
                        onSent?.invoke(offset)
                    }
                }
            }
            val status = connection.responseCode
            if (status !in 200..299) {
                val error = connection.errorStream?.bufferedReader()?.use { reader ->
                    val buffer = CharArray(4096)
                    val length = reader.read(buffer)
                    if (length > 0) String(buffer, 0, length) else ""
                }
                val detail = error?.let { runCatching { JSONObject(it).optString("error") }.getOrNull() }
                throw StatusException(status, "HTTP " + status + if (detail.isNullOrBlank()) "" else " · " + detail)
            }
            return connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    fun post(path: String, payload: JSONObject): JSONObject =
        JSONObject(request("POST", path, body = payload.toString().toByteArray()).decodeToString())
}
