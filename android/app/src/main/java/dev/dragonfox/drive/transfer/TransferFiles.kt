package dev.dragonfox.drive.transfer

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.security.MessageDigest

internal data class UploadSource(val size: Long, val open: () -> InputStream)

internal fun suffixed(name: String, index: Int): String {
    if (index == 0) return name
    val dot = name.lastIndexOf('.').takeIf { it > 0 && it != name.lastIndex } ?: name.length
    return name.substring(0, dot) + " ($index)" + name.substring(dot)
}

/** Keep temporary plaintext inside the app sandbox. Unlink immediately so process death also releases it. */
internal fun <T> withScratchFile(cache: File, block: (RandomAccessFile) -> T): T {
    val path = File.createTempFile("transfer-", ".tmp", cache)
    try {
        return RandomAccessFile(path, "rw").use {
            if (!path.delete()) throw IOException("Cannot allocate private transfer buffer")
            block(it)
        }
    } finally {
        path.delete()
    }
}

internal fun RandomAccessFile.reopen(): InputStream {
    seek(0)
    val file = this
    return object : InputStream() {
        override fun read(): Int = file.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = file.read(b, off, len)
    }
}

internal inline fun InputStream.forEachBlock(checkActive: () -> Unit, block: (ByteArray, Int) -> Unit) {
    val buffer = ByteArray(128 * 1024)
    while (true) {
        checkActive()
        val count = read(buffer)
        if (count == -1) return
        if (count > 0) block(buffer, count)
    }
}

internal fun MessageDigest.hexDigest(): String = digest().joinToString("") { "%02x".format(it) }

internal fun <T> withUploadSource(
    size: Long?, cache: File, open: () -> InputStream, checkActive: () -> Unit, block: (UploadSource) -> T,
): T {
    if (size != null) return block(UploadSource(size, open))
    // Some virtual/cloud providers cannot report a length. The encrypted upload protocol requires it before chunk 0.
    return withScratchFile(cache) { temp ->
        open().use { stream -> stream.forEachBlock(checkActive) { bytes, count -> temp.write(bytes, 0, count) } }
        block(UploadSource(temp.length(), temp::reopen))
    }
}
