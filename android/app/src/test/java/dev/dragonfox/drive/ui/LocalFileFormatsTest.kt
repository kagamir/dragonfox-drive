package dev.dragonfox.drive.ui

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LocalFileFormatsTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun recognisesPortableNamesAndMimeParameters() {
        assertEquals(PreviewKind.TEXT, previewKind(File("readme.MD"), "application/octet-stream"))
        assertEquals(PreviewKind.TEXT, previewKind(File("manifest"), "application/manifest+json; charset=utf-8"))
        assertEquals(PreviewKind.AUDIO, previewKind(File("recording"), "audio/wav"))
        assertEquals(PreviewKind.AUDIO, previewKind(File("voice.FLAC"), "application/octet-stream"))
        assertEquals(PreviewKind.PDF, previewKind(File("book"), "application/pdf"))
        assertEquals(PreviewKind.IMAGE, previewKind(File("shot.jpeg"), "image/jpeg"))
        assertEquals(PreviewKind.VIDEO, previewKind(File("video.webm"), "video/webm"))
        assertEquals(PreviewKind.OTHER, previewKind(File("office.docx"), "application/octet-stream"))
    }

    @Test fun handlesBomNewlinesUnicodeAndEmptyText() {
        val value = "一\r\n\r\n二😀"
        val expected = TextExcerpt(listOf("一", "", "二😀"), false)
        val encodings = listOf(
            byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()) to Charsets.UTF_8,
            byteArrayOf(0xff.toByte(), 0xfe.toByte()) to Charsets.UTF_16LE,
            byteArrayOf(0xfe.toByte(), 0xff.toByte()) to Charsets.UTF_16BE,
        )
        for ((bom, charset) in encodings) assertEquals(expected, decodeTextExcerpt(bom + value.toByteArray(charset)))
        assertEquals(TextExcerpt(emptyList(), false), decodeTextExcerpt(byteArrayOf()))
    }

    @Test fun rejectsBinaryAndMalformedText() {
        assertNull(decodeTextExcerpt("valid\u0000binary".toByteArray()))
        assertNull(decodeTextExcerpt(byteArrayOf(0xc3.toByte())))
        assertNull(decodeTextExcerpt(byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0, 0)))
    }

    @Test fun readsBoundedPrefixWithoutSplittingUnicodeOrAllocatingOneHugeParagraph() {
        val file = temp.newFile("data.txt")
        val prefix = "a".repeat(TEXT_BYTE_LIMIT - 1)
        file.writeText(prefix + "界" + "b".repeat(8192))
        val excerpt = requireNotNull(readTextExcerpt(file))
        assertTrue(excerpt.truncated)
        assertEquals(prefix, excerpt.rows.joinToString(""))
        assertTrue(excerpt.rows.all { it.length <= 1024 })
        assertTrue(requireNotNull(decodeTextExcerpt("\n".repeat(5000).toByteArray())).truncated)
        val emoji = "a".repeat(1023) + "🌷"
        val rows = requireNotNull(decodeTextExcerpt(emoji.toByteArray())).rows
        assertEquals(listOf("a".repeat(1023), "🌷"), rows)
    }
}
