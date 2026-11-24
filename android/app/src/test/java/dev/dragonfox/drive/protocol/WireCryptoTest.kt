package dev.dragonfox.drive.protocol

import javax.crypto.AEADBadTagException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class WireCryptoTest {
    private fun sequence(size: Int, start: Int = 0) = ByteArray(size) { (it + start).toByte() }

    // Vectors generated with the web client's libsodium-wrappers-sumo and WebCrypto parameters.
    @Test fun webAccountDerivation() {
        val key = WireCrypto.passwordKey("pärölä 密码", sequence(16))
        assertEquals("05665b1848c51d7e6b1d2ec0109b3bdb9bcf830fc345c90be1f85cb118ddabfb", WireCrypto.hex(key))
        val verifier = WireCrypto.verifier(key, sequence(16, 16))
        assertEquals("f41c5ca95e0bfce67329e96384bf173173cab43654f95f590be2cf6081bf1a1c", WireCrypto.hex(verifier))
    }

    @Test fun opensWebWrappedKey() {
        val ciphertext = WireCrypto.unhex(
            "c52b981628513641846ba98cdcde24e79292332d43b88612798623ff426ba81aaccc6cd4e5bc22019c9c671b26952e30"
        )
        assertArrayEquals(sequence(32, 192), WireCrypto.open(sequence(32), ciphertext, sequence(12, 1)))
    }

    @Test fun chunkMatchesWebAcrossAllCounterBytes() {
        val encrypted = WireCrypto.chunk(
            sequence(32), sequence(12), 0x01020304, "ff00112233445566778899aabbccddee", "云盘🎞️".toByteArray()
        )
        assertEquals("17293f11370439ccc3464de8e3f8afb878ee5f83a84d162c53c1487472", WireCrypto.hex(encrypted))
    }

    @Test fun metadataPaddingPreservesTrailingZerosAndEmptyValues() {
        for (size in listOf(0, 28, 29, 255, 256)) {
            val bytes = ByteArray(size)
            val padded = WireCrypto.pad(bytes, 32)
            assertEquals(0, padded.size % 32)
            assertArrayEquals(bytes, WireCrypto.unpad(padded))
        }
    }

    @Test(expected = IllegalArgumentException::class) fun rejectsCorruptLength() {
        WireCrypto.unpad(byteArrayOf(0x7f, -1, -1, -1))
    }

    @Test(expected = AEADBadTagException::class) fun rejectsAlteredTag() {
        val key = sequence(32)
        val sealed = WireCrypto.seal(key, byteArrayOf(1))
        sealed.bytes[0] = (sealed.bytes[0].toInt() xor 1).toByte()
        WireCrypto.open(key, sealed.bytes, sealed.iv)
    }
}
