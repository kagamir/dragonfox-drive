package dev.dragonfox.drive.ui

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.dragonfox.drive.protocol.DriveSession
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray

/** The database of session secrets is one encrypted, atomically replaced preference. */
internal class SessionVault(context: Context) {
    private val preferences = context.getSharedPreferences("drive_auth", Context.MODE_PRIVATE)
    private val alias = "dragonfox.account.key.v1"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
            generateKey()
        }
    }

    fun read(): DriveSession? {
        val record = preferences.getString("session", null) ?: return null
        val (iv, data) = record.split(".", limit = 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        val fields = JSONArray(String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8))
        return DriveSession(server = fields.getString(0), userId = fields.getString(1), username = fields.getString(2),
            masterKey = fields.getString(3), accessToken = fields.getString(4), refreshToken = fields.getString(5),
            pendingUploads = fields.optJSONArray(6)?.let { pending ->
                (0 until pending.length()).map { pending.getString(it) }.toSet()
            } ?: emptySet())
    }

    fun save(session: DriveSession) {
        val data = JSONArray(listOf(session.server, session.userId, session.username, session.masterKey,
            session.accessToken, session.refreshToken, JSONArray(session.pendingUploads.toList()))).toString().toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val body = Base64.encodeToString(cipher.doFinal(data), Base64.NO_WRAP)
        check(preferences.edit().putString("session", "$iv.$body").commit())
    }

    fun clear() {
        check(preferences.edit().remove("session").commit())
    }
}
