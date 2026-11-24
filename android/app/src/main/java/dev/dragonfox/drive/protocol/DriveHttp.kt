package dev.dragonfox.drive.protocol

import org.json.JSONObject
import java.io.IOException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.net.URI
import java.util.concurrent.TimeUnit
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

    private val client = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS)
        .build()

    fun request(
        method: String, path: String, token: String? = null, body: ByteArray? = null,
        binary: Boolean = false, expectedBytes: Int? = null, checkRead: (() -> Unit)? = null, onSent: ((Int) -> Unit)? = null
    ): ByteArray {
        val request = Request.Builder().url(base + path).header("User-Agent", "DragonFox Drive Android")
        if (token != null) request.header("Authorization", "Bearer $token")
        val data = body ?: if (method in setOf("POST", "PUT", "PATCH")) ByteArray(0) else null
        val payload = data?.let { bytes ->
            object : RequestBody() {
                override fun contentType() = (if (binary) "application/octet-stream" else "application/json").toMediaType()
                override fun contentLength() = bytes.size.toLong()
                override fun writeTo(sink: BufferedSink) {
                    var offset = 0
                    while (offset < bytes.size) {
                        val count = minOf(64 * 1024, bytes.size - offset)
                        sink.write(bytes, offset, count)
                        offset += count
                        onSent?.invoke(offset)
                    }
                }
            }
        }
        client.newCall(request.method(method, payload).build()).execute().use { response ->
            if (!response.isSuccessful) {
                val detail = runCatching { JSONObject(response.peekBody(4096).string()).optString("error") }.getOrNull()
                throw StatusException(response.code, "HTTP " + response.code + if (detail.isNullOrBlank()) "" else " · " + detail)
            }
            val responseBody = response.body ?: return ByteArray(0)
            if (expectedBytes == null) return responseBody.bytes()
            val declared = responseBody.contentLength()
            if (declared >= 0 && declared != expectedBytes.toLong()) throw IOException("Invalid encrypted chunk length")
            val output = ByteArray(expectedBytes)
            val stream = responseBody.byteStream()
            var offset = 0
            while (offset < output.size) {
                checkRead?.invoke()
                val count = stream.read(output, offset, minOf(16 * 1024, output.size - offset))
                if (count < 0) throw IOException("Truncated encrypted chunk")
                offset += count
            }
            if (stream.read() != -1) throw IOException("Oversized encrypted chunk")
            return output
        }
    }

    fun post(path: String, payload: JSONObject): JSONObject =
        JSONObject(request("POST", path, body = payload.toString().toByteArray()).decodeToString())
}
