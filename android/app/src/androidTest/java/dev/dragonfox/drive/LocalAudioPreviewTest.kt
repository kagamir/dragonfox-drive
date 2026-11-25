package dev.dragonfox.drive

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.dragonfox.drive.ui.LocalFilePreview
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LocalAudioPreviewTest {
    @get:Rule val screen = createComposeRule()

    @Test fun localPcmAudioStartsOnRequestCanPauseAndCloses() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val audio = File.createTempFile("dragonfox-audio-", ".wav", context.cacheDir)
        val pcm = ByteArray(8000 * 2 * 15) // 15 seconds, mono 16-bit PCM at 8 kHz.
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            .put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVEfmt ".toByteArray())
            .putInt(16).putShort(1).putShort(1).putInt(8000).putInt(16000).putShort(2).putShort(16)
            .put("data".toByteArray()).putInt(pcm.size)
        audio.outputStream().use { it.write(header.array()); it.write(pcm) }
        try {
            screen.setContent {
                var opened by remember { mutableStateOf(true) }
                MaterialTheme { if (opened) LocalFilePreview(audio, "audio/wav") { opened = false } }
            }
            val toggle = hasTestTag("viewer-play-toggle") and isEnabled()
            screen.waitUntil(15_000) { screen.onAllNodes(toggle).fetchSemanticsNodes().isNotEmpty() }
            val play = context.getString(R.string.df_play_audio)
            screen.onNodeWithContentDescription(play).performClick()
            screen.waitUntil(15_000) {
                val state = screen.onNodeWithTag("viewer-seek").fetchSemanticsNode().config
                state[SemanticsProperties.ProgressBarRangeInfo].current > 0f
            }
            screen.onNodeWithContentDescription(context.getString(R.string.df_pause_audio)).performClick()
            screen.waitUntil(5000) { screen.onAllNodesWithContentDescription(play).fetchSemanticsNodes().isNotEmpty() }
            screen.onNodeWithContentDescription(context.getString(R.string.df_back)).performClick()
            screen.onNodeWithTag("file-audio").assertDoesNotExist()
        } finally { audio.delete() }
    }
}
