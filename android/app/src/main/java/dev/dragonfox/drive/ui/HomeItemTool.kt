package dev.dragonfox.drive.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File

internal fun canEditHomeFile(file: CloudFile): Boolean =
    file.size in 0..HOME_TEXT_LIMIT.toLong() && previewKind(File(file.name), file.mime) == PreviewKind.TEXT

/** A single account-scoped editor buffer. Large plaintext drafts must stay out of the Activity Bundle. */
internal class HomeTextDraft {
    var fileId by mutableStateOf<String?>(null)
    var document by mutableStateOf<HomeTextDocument?>(null)
    var text by mutableStateOf("")
    var conflict by mutableStateOf(false)
    var reviewing by mutableStateOf(false)

    fun clear() {
        fileId = null
        document = null
        text = ""
        conflict = false
        reviewing = false
    }
}

@Composable
internal fun HomeItemTool(tool: HomeTool, file: CloudFile, model: DriveModel, onDismiss: () -> Unit) {
    key(tool, file.id) {
        when (tool) {
            HomeTool.EDIT_TEXT -> HomeEditor(file, model, onDismiss)
            HomeTool.SHARE -> HomeShareDialog(file, model, onDismiss)
        }
    }
}

@Composable
private fun HomeEditor(file: CloudFile, model: DriveModel, onDismiss: () -> Unit) {
    val draft = model.homeTextDraft
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempts by remember { mutableIntStateOf(0) }
    var discard by remember { mutableStateOf(false) }
    val document = draft.document.takeIf { draft.fileId == file.id }
    val dirty = document != null && draft.text != document.text

    fun close() {
        draft.clear()
        onDismiss()
    }
    fun requestClose() {
        if (!busy) {
            if (dirty) discard = true else close()
        }
    }
    LaunchedEffect(file.id, attempts) {
        if (draft.fileId != file.id) {
            draft.clear()
            draft.fileId = file.id
        }
        if (draft.document != null) return@LaunchedEffect
        busy = true
        error = null
        try {
            val original = model.homeRead { it.openHomeText(file) }
            draft.document = original
            draft.text = original.text
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = context.getString(if (e is java.nio.charset.CharacterCodingException) R.string.df_edit_encoding else R.string.df_edit_load_error)
        } finally { busy = false }
    }
    val bytes = remember(draft.text) { draft.text.toByteArray().size }
    AlertDialog(onDismissRequest = ::requestClose, title = { Text(file.name) },
        text = { Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (document != null) {
                if (draft.reviewing) {
                    Text(stringResource(R.string.df_edit_latest), style = MaterialTheme.typography.labelLarge)
                    OutlinedTextField(document.text, {}, readOnly = true, maxLines = 4, modifier = Modifier.fillMaxWidth())
                }
                OutlinedTextField(draft.text, { draft.text = it }, enabled = !busy,
                    modifier = Modifier.fillMaxWidth().testTag("home-edit-draft"), label = { Text(stringResource(R.string.df_edit_draft)) },
                    minLines = 4, maxLines = 10, textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                if (bytes > HOME_TEXT_LIMIT) Text(stringResource(R.string.df_edit_too_large), color = MaterialTheme.colorScheme.error)
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (document == null && error != null && !busy) TextButton(onClick = { attempts++ }) { Text(stringResource(R.string.df_retry)) }
            if (draft.conflict) {
                Text(stringResource(R.string.df_edit_conflict), color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.testTag("home-edit-conflict"))
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            val latest = model.homeRead { api ->
                                api.listFolders()
                                val fresh = api.listFiles().first { it.id == file.id }
                                check(canEditHomeFile(fresh))
                                api.openHomeText(fresh)
                            }
                            draft.document = latest
                            draft.reviewing = true
                            draft.conflict = false
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            error = context.getString(R.string.df_edit_load_error)
                        } finally { busy = false }
                    }
                }) { Text(stringResource(R.string.df_edit_compare)) }
            }
        } },
        dismissButton = { TextButton(onClick = ::requestClose, enabled = !busy) { Text(stringResource(R.string.df_cancel)) } },
        confirmButton = { Button(enabled = dirty && !busy && !draft.conflict && bytes in 1..HOME_TEXT_LIMIT,
            modifier = Modifier.testTag("home-edit-save"), onClick = {
                val base = document ?: return@Button
                val value = draft.text
                busy = true
                error = null
                scope.launch {
                    try {
                        model.homeWrite { it.saveHomeText(base, value) }
                        close()
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        if (e is StatusException && e.status == 409) draft.conflict = true
                        else error = context.getString(R.string.df_edit_save_error)
                    } finally { busy = false }
                }
            }) { Text(stringResource(R.string.df_edit_save)) } })
    if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text(stringResource(R.string.df_edit_discard_question)) },
        confirmButton = { TextButton(onClick = ::close) { Text(stringResource(R.string.df_edit_discard)) } },
        dismissButton = { TextButton(onClick = { discard = false }) { Text(stringResource(R.string.df_edit_keep)) } })
}
