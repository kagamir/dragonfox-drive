package dev.dragonfox.drive.protocol

import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters

data class SealedBytes(val iv: ByteArray, val bytes: ByteArray)

/** The same wire format used by web/src/crypto; changes require a versioned migration. */
object WireCrypto {
    private val rng = SecureRandom()
    private const val HEX = "0123456789abcdef"

    fun random(n: Int): ByteArray = ByteArray(n).also(rng::nextBytes)

    fun hex(bytes: ByteArray): String = buildString(bytes.size * 2) {
        for (byte in bytes) {
            val n = byte.toInt() and 0xff
            append(HEX[n ushr 4])
            append(HEX[n and 0xf])
        }
    }

    fun unhex(str: String): ByteArray {
        require(str.length % 2 == 0) { "Invalid hex length" }
        return ByteArray(str.length / 2) { index ->
            val high = Character.digit(str[index * 2], 16)
            val low = Character.digit(str[index * 2 + 1], 16)
            require(high >= 0 && low >= 0) { "Invalid hex digit" }
            ((high shl 4) or low).toByte()
        }
    }

    // JSON ciphertext fields use the padded RFC 4648 standard alphabet.
    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun unb64(str: String): ByteArray = Base64.getDecoder().decode(str)

    fun passwordKey(password: String, salt: ByteArray): ByteArray =
        derive(password.toByteArray(Charsets.UTF_8), salt.copyOf(16))

    fun verifier(key: ByteArray, salt: ByteArray): ByteArray {
        require(key.size == 32 && salt.size == 16)
        // libsodium's to_base64() default for this second pass is URLSAFE_NO_PADDING.
        return derive(Base64.getUrlEncoder().withoutPadding().encode(key), salt)
    }

    private fun derive(input: ByteArray, salt: ByteArray): ByteArray {
        // The deployed browser passes 65536 BYTES to crypto_pwhash. BC accepts KiB.
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withIterations(3)
            .withMemoryAsKB(64)
            .withParallelism(1)
            .withSalt(salt)
            .build()
        return try {
            val generator = Argon2BytesGenerator()
            generator.init(params)
            ByteArray(32).also { generator.generateBytes(input, it) }
        } finally {
            input.fill(0)
            params.clear()
        }
    }

    private fun cipher(mode: Int, key: ByteArray, iv: ByteArray): Cipher {
        require(key.size == 32 && iv.size == 12)
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        }
    }

    fun seal(key: ByteArray, plain: ByteArray): SealedBytes {
        val iv = random(12)
        return SealedBytes(iv, cipher(Cipher.ENCRYPT_MODE, key, iv).doFinal(plain))
    }

    fun open(key: ByteArray, bytes: ByteArray, iv: ByteArray): ByteArray =
        cipher(Cipher.DECRYPT_MODE, key, iv).doFinal(bytes)

    fun pad(bytes: ByteArray, block: Int): ByteArray {
        require(block > 0)
        val length = ((bytes.size.toLong() + 4 + block - 1) / block) * block
        require(length <= Int.MAX_VALUE)
        return ByteBuffer.allocate(length.toInt()).putInt(bytes.size).put(bytes).array()
    }

    fun unpad(bytes: ByteArray): ByteArray {
        require(bytes.size >= 4) { "Missing encrypted metadata length" }
        val length = ByteBuffer.wrap(bytes).int
        require(length in 0..(bytes.size - 4)) { "Invalid encrypted metadata length" }
        return bytes.copyOfRange(4, 4 + length)
    }

    fun chunk(key: ByteArray, ivBase: ByteArray, index: Int, contentId: String, plain: ByteArray): ByteArray =
        chunkCipher(Cipher.ENCRYPT_MODE, key, ivBase, index, contentId).doFinal(plain)

    fun openChunk(key: ByteArray, ivBase: ByteArray, index: Int, contentId: String, bytes: ByteArray): ByteArray =
        chunkCipher(Cipher.DECRYPT_MODE, key, ivBase, index, contentId).doFinal(bytes)

    private fun chunkCipher(mode: Int, key: ByteArray, ivBase: ByteArray, index: Int, contentId: String): Cipher {
        require(index >= 0 && ivBase.size == 12)
        val iv = ivBase.copyOf()
        val view = ByteBuffer.wrap(iv)
        view.putInt(8, view.getInt(8) xor index)
        return cipher(mode, key, iv).apply {
            updateAAD("$contentId:$index".toByteArray(Charsets.UTF_8))
        }
    }
}
