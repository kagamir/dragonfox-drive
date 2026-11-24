package dev.dragonfox.drive

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.protocol.DriveSession
import dev.dragonfox.drive.ui.SessionVault
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionVaultTest {
    @Test
    fun sessionSurvivesReopenAndIsRemovedOnLogout() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vault = SessionVault(context)
        val session = DriveSession("https://drive.example.org", "test-id", "test-user",
            "example-master-key", "example-access-token", "example-refresh-token")
        try {
            vault.save(session)
            val record = context.getSharedPreferences("drive_auth", Context.MODE_PRIVATE).getString("session", null)!!
            listOf(session.masterKey, session.accessToken, session.refreshToken).forEach {
                assertFalse(record.contains(it))
            }
            val restored = SessionVault(context).read()!!
            assertEquals(session.masterKey, restored.masterKey)
            assertEquals(session.refreshToken, restored.refreshToken)
            assertEquals(session.server, restored.server)
        } finally {
            vault.clear()
        }
        assertNull(SessionVault(context).read())
    }
}
