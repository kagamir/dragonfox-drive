package dev.dragonfox.drive

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AccountScreenTest {
    @get:Rule
    val screen = createAndroidComposeRule<MainActivity>()

    @Test
    fun signedOutUserCanEnterServerAndSwitchBetweenLoginAndRegistration() {
        screen.waitUntil(10_000) { screen.onAllNodesWithTag("auth-server").fetchSemanticsNodes().isNotEmpty() }
        screen.onNodeWithTag("auth-server").assertIsDisplayed().performTextInput("https://drive.example.org")
        screen.onNodeWithTag("auth-username").performTextInput("android-user")
        screen.onNodeWithTag("auth-password").assertExists()
        screen.onNodeWithTag("auth-switch").performScrollTo().performClick()
        screen.onNodeWithTag("auth-confirm").assertExists()
        screen.onNodeWithTag("auth-switch").performScrollTo().performClick()
        screen.onNodeWithTag("auth-confirm").assertDoesNotExist()
        screen.onNodeWithTag("auth-submit").assertExists()
    }
}
