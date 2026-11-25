package dev.dragonfox.drive

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.core.view.WindowCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.ui.SessionVault
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SignedInTabsTest {
    @get:Rule val screen = createEmptyComposeRule()

    @Test fun cloudNavigationAndCustomSettingsSurviveChangingTabsAndRelaunching() {
        val server = InstrumentationRegistry.getArguments().getString("syncServer")
        assumeNotNull(server)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vault = SessionVault(context)
        val appearance = context.getSharedPreferences("appearance", Context.MODE_PRIVATE)
        val previousTheme = appearance.getString("theme", null)
        val username = "tabs_" + UUID.randomUUID().toString().take(8)
        val client = DriveClient.register(requireNotNull(server), username, UUID.randomUUID().toString()) {}
        try {
            val album = client.createFolder(null, "Home tab fixture")
            val child = client.createFolder(album.id, "Inside home tab fixture")
            vault.save(client.session)
            appearance.edit().putString("theme", "LIGHT").commit()
            val dark = context.getString(R.string.df_theme_dark)
            val applyLabel = context.getString(R.string.df_apply)

            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                awaitText(album.name)
                screen.onNodeWithTag("tab-home").assertIsSelected()
                screen.onNodeWithText(album.name).performClick()
                awaitText(child.name)

                screen.onNodeWithTag("tab-sync").performClick().assertIsSelected()
                row("sync-edit").assertIsDisplayed()
                screen.onNodeWithTag("tab-account").performClick().assertIsSelected()
                row("preference-theme").performClick()
                screen.onNodeWithText(dark).performClick()
                row("preference-theme").assertTextContains(dark)
                scenario.onActivity {
                    assertFalse(WindowCompat.getInsetsController(it.window, it.window.decorView).isAppearanceLightStatusBars)
                }
                setNumber("preference-depth", "7", applyLabel)
                setNumber("preference-interval", "180", applyLabel)
                screen.onNodeWithTag("tab-home").performClick().assertIsSelected()
                awaitText(child.name)
            }
            // A fresh Activity and ViewModel read the encrypted session and settings from disk.
            ActivityScenario.launch(MainActivity::class.java).use {
                awaitText(album.name)
                screen.onNodeWithTag("tab-home").assertIsSelected()
                screen.onNodeWithTag("tab-account").performClick()
                row("preference-theme").assertTextContains(dark)
                row("preference-depth").assertTextContains(context.getString(R.string.df_levels, 7))
                row("preference-interval").assertTextContains(context.getString(R.string.df_seconds, 180))
            }
        } finally {
            appearance.edit().putString("theme", previousTheme).commit()
            vault.clear()
            client.logout()
        }
    }

    private fun awaitText(text: String) {
        screen.waitUntil(30_000) { screen.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
        screen.onNodeWithText(text).assertIsDisplayed()
    }

    private fun row(tag: String) = screen.onNodeWithTag(tag).also {
        screen.onNode(hasScrollAction()).performScrollToNode(hasTestTag(tag))
    }

    private fun setNumber(tag: String, value: String, applyLabel: String) {
        row(tag).performClick()
        screen.onNodeWithTag("preference-value").performTextReplacement(value)
        screen.onNodeWithText(applyLabel).performClick()
    }
}
