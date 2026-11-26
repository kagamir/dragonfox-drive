package dev.dragonfox.drive

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.protocol.openHomeText
import dev.dragonfox.drive.protocol.saveHomeText

internal fun checkHomeEditConflict(screen: ComposeTestRule, client: DriveClient, file: CloudFile, draft: String) {
    val concurrent = "Updated from another client"
    client.saveHomeText(client.openHomeText(file), concurrent)
    screen.onNodeWithTag("home-edit-save").performClick()
    screen.waitUntil(30_000) { screen.onAllNodesWithTag("home-edit-conflict").fetchSemanticsNodes().isNotEmpty() }
    screen.onNodeWithTag("home-edit-draft").assertTextContains(draft)
    screen.onNodeWithTag("home-edit-save").assertIsNotEnabled()
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    screen.onNodeWithText(context.getString(R.string.df_cancel)).performClick()
    screen.onNodeWithText(context.getString(R.string.df_edit_keep)).performClick()
    screen.onNodeWithTag("home-edit-draft").assertTextContains(draft)
    val compare = context.getString(R.string.df_edit_compare)
    screen.onNodeWithText(compare).performScrollTo().performClick()
    screen.waitUntil(30_000) { screen.onAllNodesWithText(concurrent).fetchSemanticsNodes().isNotEmpty() }
    screen.onNodeWithTag("home-edit-draft").assertTextContains(draft)
    screen.onNodeWithTag("home-edit-save").assertIsEnabled()
}
