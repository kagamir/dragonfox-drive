package dev.dragonfox.drive.ui

import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.Charset
import java.nio.file.Files
import java.nio.file.LinkOption
import java.util.Locale

internal enum class PreviewKind { IMAGE, VIDEO, AUDIO, PDF, TEXT, OTHER }

private val textExtensions = setOf(
    "txt", "md", "markdown", "json", "jsonl", "xml", "csv", "tsv", "log", "yaml", "yml", "toml", "ini",
    "cfg", "conf", "properties", "html", "htm", "css", "js", "kt", "java", "py", "sh", "sql", "srt", "vtt",
)
private val audioExtensions = setOf("mp3", "m4a", "wav", "ogg", "opus", "flac", "aac", "amr", "mid", "midi")

internal fun previewKind(file: File, mime: String): PreviewKind {
    val type = mime.substringBefore(';').trim().lowercase(Locale.ROOT)
    val ext = file.extension.lowercase(Locale.ROOT)
    return when {
        type.startsWith("image/") -> PreviewKind.IMAGE
        type.startsWith("video/") -> PreviewKind.VIDEO
        type.startsWith("audio/") -> PreviewKind.AUDIO
        type == "application/pdf" || ext == "pdf" -> PreviewKind.PDF
        type.startsWith("text/") || type in setOf("application/json", "application/xml", "application/javascript") ||
            type.endsWith("+json") || type.endsWith("+xml") || ext in textExtensions -> PreviewKind.TEXT
        ext in audioExtensions -> PreviewKind.AUDIO
        else -> PreviewKind.OTHER
    }
}

internal const val TEXT_BYTE_LIMIT = 64 * 1024
private const val MAX_TEXT_ROWS = 1500
private const val MAX_ROW_CHARS = 1024

internal data class TextExcerpt(val rows: List<String>, val truncated: Boolean)

internal fun readTextExcerpt(file: File): TextExcerpt? {
    if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) throw IOException("File is unavailable")
    val data = ByteArray(TEXT_BYTE_LIMIT + 1)
    var length = 0
    Files.newInputStream(file.toPath(), LinkOption.NOFOLLOW_LINKS).use { input ->
        while (length < data.size) {
            val count = input.read(data, length, data.size - length)
            if (count < 0) break
            length += count
        }
    }
    return decodeTextExcerpt(data, length)
}

internal fun decodeTextExcerpt(data: ByteArray, length: Int = data.size): TextExcerpt? {
    val byteCount = minOf(length, TEXT_BYTE_LIMIT)
    val clipped = length > byteCount
    fun starts(vararg values: Int): Boolean = byteCount >= values.size && values.indices.all {
        (data[it].toInt() and 0xff) == values[it]
    }
    val encoding: Charset
    val offset: Int
    when {
        starts(0xff, 0xfe, 0x00, 0x00) || starts(0x00, 0x00, 0xfe, 0xff) -> return null
        starts(0xef, 0xbb, 0xbf) -> { encoding = Charsets.UTF_8; offset = 3 }
        starts(0xff, 0xfe) -> { encoding = Charsets.UTF_16LE; offset = 2 }
        starts(0xfe, 0xff) -> { encoding = Charsets.UTF_16BE; offset = 2 }
        else -> { encoding = Charsets.UTF_8; offset = 0 }
    }

    // An incomplete final character is valid only when our own byte limit split it.
    val chars = CharBuffer.allocate(byteCount - offset)
    val result = encoding.newDecoder().decode(ByteBuffer.wrap(data, offset, byteCount - offset), chars, !clipped)
    if (result.isError) return null
    chars.flip()
    val text = chars.toString()
    if (text.any { it.isISOControl() && it != '\n' && it != '\r' && it != '\t' }) return null
    if (text.isEmpty()) return TextExcerpt(emptyList(), clipped)

    val rows = mutableListOf<String>()
    for (line in text.lineSequence()) {
        var start = 0
        do {
            if (rows.size == MAX_TEXT_ROWS) return TextExcerpt(rows, true)
            var end = minOf(start + MAX_ROW_CHARS, line.length)
            if (end < line.length && line[end - 1].isHighSurrogate()) end--
            rows.add(line.substring(start, end))
            start = end
        } while (start < line.length)
    }
    return TextExcerpt(rows, clipped)
}
