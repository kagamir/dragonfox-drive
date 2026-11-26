package dev.dragonfox.drive

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.protocol.DriveClient
import dev.dragonfox.drive.ui.SessionVault
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HomeManagementTest {
    @get:Rule val screen = createEmptyComposeRule()

    @Test fun manageFoldersAndFilesFromTheSignedInHomeTab() {
        val server = InstrumentationRegistry.getArguments().getString("syncServer")
        assumeNotNull(server)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val username = "home_" + UUID.randomUUID().toString().take(12)
        val client = DriveClient.register(requireNotNull(server), username, UUID.randomUUID().toString()) {}
        val vault = SessionVault(context)
        val priorSession = vault.read()
        val work = File(context.cacheDir, username).apply { check(mkdir()) }
        try {
            val source = client.createFolder(null, "Travel")
            val nested = client.createFolder(source.id, "Tokyo")
            val insideFile = client.upload(nested.id, File(work, "tickets.bin").apply { writeBytes(byteArrayOf(3, 9, -1)) },
                "application/octet-stream") {}
            vault.save(client.session)

            ActivityScenario.launch(MainActivity::class.java).use {
                waitFor("home-row-" + source.id)
                click("home-add")
                click("home-new-folder")
                nameAndConfirm("Inbox")
                waitText("Inbox")
                val destination = client.listFolders().single { it.name == "Inbox" }
                click("home-more-" + destination.id)
                click("home-rename")
                nameAndConfirm("Archive")
                waitText("Archive")
                assertEquals("Archive", client.listFolders().single { it.id == destination.id }.name)

                click("home-add")
                click("home-new-text")
                waitFor("home-content")
                screen.onNodeWithTag("home-content").performTextReplacement("first draft")
                nameAndConfirm("notes.txt")
                waitText("notes.txt")
                val looseFile = client.listFiles().single { it.name == "notes.txt" }
                click("home-row-" + looseFile.id)
                waitFor("home-edit-draft")
                val editedText = "東京 — field notes"
                screen.onNodeWithTag("home-edit-draft").performTextReplacement(editedText)
                checkHomeEditConflict(screen, client, looseFile, editedText)
                click("home-edit-save")
                waitGone("home-edit-draft")

                // One bulk operation moves a nonempty folder and a loose file.
                click("home-more-" + source.id)
                click("home-select")
                click("home-row-" + looseFile.id)
                click("home-move")
                waitFor("home-destination-" + destination.id)
                screen.onNodeWithTag("home-confirm").assertIsNotEnabled()
                screen.onNodeWithTag("home-destination-" + source.id).assertDoesNotExist()
                click("home-destination-" + destination.id)
                click("home-confirm")
                waitGone("home-confirm")
                waitFor("home-row-" + destination.id)
                waitGone("home-row-" + source.id)
                waitGone("home-row-" + looseFile.id)
                val movedFolders = client.listFolders().associateBy { it.id }
                assertEquals(destination.id, movedFolders.getValue(source.id).parentId)
                assertEquals(source.id, movedFolders.getValue(nested.id).parentId)
                val movedFiles = client.listFiles().associateBy { it.id }
                assertEquals(destination.id, movedFiles.getValue(looseFile.id).parentId)
                assertEquals(nested.id, movedFiles.getValue(insideFile.id).parentId)

                click("home-row-" + destination.id)
                click("home-more-" + looseFile.id)
                click("home-rename")
                nameAndConfirm("notebook.txt")
                waitText("notebook.txt")
                val renamed = client.listFiles().single { it.id == looseFile.id }
                assertEquals("notebook.txt", renamed.name)
                val downloaded = ByteArrayOutputStream()
                client.readFile(renamed, {}) { bytes -> downloaded.write(bytes); true }
                assertArrayEquals(editedText.toByteArray(), downloaded.toByteArray())

                click("home-more-" + looseFile.id)
                click("home-share")
                click("home-share-create")
                waitFor("home-share-link")
                val link = screen.onNodeWithTag("home-share-link", useUnmergedTree = true).fetchSemanticsNode()
                    .config[SemanticsProperties.Text].single().text
                assertTrue(link.startsWith(server.trimEnd('/') + "/#/s/") && link.contains("?k="))
                screen.onNodeWithText(context.getString(R.string.df_close)).performClick()

                click("home-more-" + source.id)
                click("home-delete")
                click("home-cancel")
                waitGone("home-confirm")
                screen.onNodeWithTag("home-row-" + source.id).assertIsDisplayed()
                assertTrue(client.listFiles().any { it.id == insideFile.id })

                click("home-more-" + source.id)
                click("home-delete")
                click("home-confirm")
                waitGone("home-row-" + source.id)
                assertEquals(setOf(destination.id), client.listFolders().map { it.id }.toSet())
                assertEquals(listOf(looseFile.id), client.listFiles().map { it.id })

                click("home-more-" + looseFile.id)
                click("home-delete")
                click("home-confirm")
                waitGone("home-row-" + looseFile.id)
                assertTrue(client.listFiles().isEmpty())
            }
        } finally {
            work.deleteRecursively()
            if (priorSession == null) vault.clear() else vault.save(priorSession)
            client.logout()
        }
    }

    private fun waitFor(tag: String) = screen.waitUntil(30_000) {
        screen.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitGone(tag: String) = screen.waitUntil(30_000) {
        screen.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty()
    }

    private fun waitText(value: String) = screen.waitUntil(30_000) {
        screen.onAllNodesWithText(value).fetchSemanticsNodes().isNotEmpty()
    }

    private fun click(tag: String) {
        waitFor(tag)
        screen.onNodeWithTag(tag).performClick()
    }

    private fun nameAndConfirm(name: String) {
        waitFor("home-name")
        screen.onNodeWithTag("home-name").performTextReplacement(name)
        click("home-confirm")
        waitGone("home-name")
    }
}
