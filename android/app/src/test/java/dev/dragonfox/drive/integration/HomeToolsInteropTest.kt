package dev.dragonfox.drive.integration

import dev.dragonfox.drive.protocol.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.time.Instant

class HomeToolsInteropTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun shareDerivationMatchesLibsodiumForUnicodeAndBinarySecrets() {
        val salt = ByteArray(16) { it.toByte() }
        assertEquals("e5ee9df1216d9c549808a3f358972437a3c70907170f49a915e8b6a8774cfabb",
            WireCrypto.hex(shareWrappingKey("云盘🔐-pass".toByteArray(), salt)))
        assertEquals("5efab0d526dc0a0834e189e9b8fdb35fcba17a6af0d74693ebd9040172637a47",
            WireCrypto.hex(shareWrappingKey(ByteArray(32) { if (it % 2 == 0) 0xfb.toByte() else 0xff.toByte() }, salt)))
    }

    @Test fun recipientCanDecryptEditedTextAndStaleEditorsCannotOverwriteIt() {
        withTestServer(temp.newFolder("home-tools-server")) { server ->
            val client = DriveClient.register(server, "home_tools", "safe-test-password") {}
            val guest = DriveHttp(server)
            val folder = client.createFolder(null, "Shared notes")
            val source = temp.newFile("行程.md").apply { writeText("initial text") }
            client.upload(folder.id, source, "text/markdown") {}
            val file = client.listFiles().single()
            val editor = client.openHomeText(file)
            assertEquals(source.readText(), editor.text)
            val expiry = Instant.now().plusSeconds(3600)
            val openLink = URI(client.createHomeShare(file, null, expiry, 1))
            assertNull(openLink.rawQuery)
            val fragment = openLink.rawFragment
            val publicEndpoint = "/api/shares/" + fragment.substringAfter("/s/").substringBefore("?")
            val secret = WireCrypto.unb64(URLDecoder.decode(fragment.substringAfter("?k="), "UTF-8"))
            assertEquals(32, secret.size)

            val password = "城市🔓+/"
            val locked = URI(client.createHomeShare(file, password, null, 2))
            assertFalse(locked.rawFragment.contains("?"))
            val lockedEndpoint = "/api/shares/" + locked.rawFragment.substringAfter("/s/")
            val old = "北京 → 上海\n第二行"
            client.saveHomeText(editor, old)
            val error = assertThrows(StatusException::class.java) { client.saveHomeText(editor, "stale overwrite") }
            assertEquals(409, error.status)
            val revised = client.listFiles().single()
            assertEquals(old, client.openHomeText(revised).text)
            assertEquals(file.id, revised.id)
            assertNotEquals(file.revision, revised.revision)

            fun read(path: String) = JSONObject(guest.request("GET", path).decodeToString())
            fun decrypt(path: String, result: JSONObject, key: ByteArray): String {
                val fileKey = WireCrypto.open(key, WireCrypto.unb64(result.getString("encrypted_file_key")),
                    WireCrypto.unb64(result.getString("encrypted_file_key_nonce")))
                val manifest = JSONObject(WireCrypto.unpad(WireCrypto.open(fileKey,
                    WireCrypto.unb64(result.getString("encrypted_manifest")),
                    WireCrypto.unb64(result.getString("encrypted_manifest_nonce")))).decodeToString())
                assertEquals(source.name, manifest.getString("name"))
                val plain = WireCrypto.openChunk(fileKey, WireCrypto.unb64(manifest.getString("iv_base")),
                    0, manifest.getString("content_id"), guest.request("GET", "$path/chunks/0"))
                assertEquals(WireCrypto.hex(MessageDigest.getInstance("SHA-256").digest(plain)), manifest.getString("plaintext_sha256"))
                return plain.decodeToString()
            }
            val unprotected = read(publicEndpoint)
            val linkKey = shareWrappingKey(secret, WireCrypto.unb64(unprotected.getString("share_salt")))
            assertEquals(old, decrypt(publicEndpoint, unprotected, linkKey))
            assertEquals("exhausted", read(publicEndpoint).getString("state"))
            val gated = read(lockedEndpoint)
            assertTrue(gated.getBoolean("requires_password"))
            assertFalse(gated.has("encrypted_file_key"))
            val wrong = assertThrows(StatusException::class.java) {
                guest.post("$lockedEndpoint/verify", JSONObject().put("password_verifier", "00".repeat(32)))
            }
            assertEquals(401, wrong.status)
            val passKey = shareWrappingKey(password.toByteArray(), WireCrypto.unb64(gated.getString("share_salt")))
            val unlocked = guest.post("$lockedEndpoint/verify", JSONObject().put("password_verifier",
                WireCrypto.hex(MessageDigest.getInstance("SHA-256").digest(passKey))))
            assertEquals(old, decrypt(lockedEndpoint, unlocked, passKey))
            client.logout()
        }
    }
}
