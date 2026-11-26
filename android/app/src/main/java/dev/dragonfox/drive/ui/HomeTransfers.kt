package dev.dragonfox.drive.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import android.text.format.Formatter
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.transfer.ManualTransfers
import dev.dragonfox.drive.transfer.TransferPhase
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged

internal class HomeTransfers(
    val busy: Boolean,
    val pickFiles: (String?) -> Unit,
    val pickFolder: (String?) -> Unit,
    val saveFile: (CloudFile) -> Unit,
)

private object CreateDownloadDocument : ActivityResultContract<CloudFile, Uri?>() {
    override fun createIntent(context: Context, input: CloudFile): Intent {
        val declared = input.mime.substringBefore(';').trim().lowercase()
        val mime = declared.takeIf { '/' in it && it != "application/octet-stream" && it != "binary/octet-stream" }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(input.name.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
        return ActivityResultContracts.CreateDocument(mime).createIntent(context, input.name)
    }

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        if (resultCode == Activity.RESULT_OK) intent?.data else null
}

@Composable
internal fun rememberHomeTransfers(manager: ManualTransfers): HomeTransfers {
    val context = LocalContext.current
    val running by remember(manager) {
        manager.state.map { it.phase == TransferPhase.RUNNING }.distinctUntilChanged()
    }.collectAsState(initial = manager.state.value.phase == TransferPhase.RUNNING)
    var owner by rememberSaveable { mutableStateOf<String?>(null) }
    var parent by rememberSaveable { mutableStateOf<String?>(null) }
    var save by rememberSaveable { mutableStateOf<ArrayList<String>?>(null) }
    fun resetPicker() { owner = null; parent = null; save = null }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (owner == manager.accountKey && uris.isNotEmpty()) manager.uploadFiles(parent, uris)
        resetPicker()
    }
    val folder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree: Uri? ->
        if (owner == manager.accountKey && tree != null) manager.uploadFolder(parent, tree)
        resetPicker()
    }
    val destination = rememberLauncherForActivityResult(CreateDownloadDocument) { output ->
        val fields = save
        if (owner == manager.accountKey && output != null && fields != null) {
            manager.download(CloudFile(fields[0], fields[1].ifEmpty { null }, fields[2], fields[3].toLong(),
                fields[4].ifEmpty { null }, fields[5], fields[6], fields[7].ifEmpty { null }), output)
        }
        resetPicker()
    }
    fun launch(parentId: String?, file: CloudFile? = null, action: () -> Unit) {
        if (manager.state.value.phase == TransferPhase.RUNNING || owner == manager.accountKey) return
        owner = manager.accountKey
        parent = parentId
        save = file?.let { arrayListOf(it.id, it.parentId.orEmpty(), it.name, it.size.toString(),
            it.sha256.orEmpty(), it.revision, it.mime, it.createdAt.orEmpty()) }
        try { action() } catch (_: android.content.ActivityNotFoundException) {
            resetPicker()
            Toast.makeText(context, R.string.transfer_no_picker, Toast.LENGTH_LONG).show()
        }
    }
    return HomeTransfers(running || owner == manager.accountKey,
        { parentId -> launch(parentId) { files.launch(arrayOf("*/*")) } },
        { parentId -> launch(parentId) { folder.launch(null) } },
        { file -> launch(null, file) { destination.launch(file) } })
}

@Composable
internal fun TransferPanel(manager: ManualTransfers, transfers: HomeTransfers, modifier: Modifier = Modifier) {
    val state by manager.state.collectAsState()
    if (state.phase == TransferPhase.IDLE) return
    val context = LocalContext.current
    val title = when (state.phase) {
        TransferPhase.RUNNING -> if (state.downloading) R.string.transfer_downloading else R.string.transfer_uploading
        TransferPhase.DONE -> R.string.transfer_done
        TransferPhase.CANCELLED -> R.string.transfer_cancelled
        else -> R.string.transfer_failed
    }
    Surface(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(title), style = MaterialTheme.typography.titleSmall)
            if (state.path.isNotEmpty()) Text(state.path, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodySmall)
            if (state.phase == TransferPhase.RUNNING) {
                val size = state.size
                if (size != null && size > 0) {
                    LinearProgressIndicator(progress = { (state.bytes.toDouble() / size).toFloat().coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth())
                    Text(stringResource(R.string.transfer_bytes, Formatter.formatShortFileSize(context, state.bytes),
                        Formatter.formatShortFileSize(context, size)), style = MaterialTheme.typography.labelSmall)
                } else LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            state.total?.let { total ->
                if (total > 0) Text(stringResource(R.string.transfer_count, state.completed, total), style = MaterialTheme.typography.labelSmall)
            }
            state.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                if (state.phase == TransferPhase.RUNNING) {
                    TextButton(onClick = manager::cancel) { Text(stringResource(R.string.transfer_cancel)) }
                } else {
                    TextButton(onClick = manager::dismiss) { Text(stringResource(R.string.transfer_dismiss)) }
                    if (state.phase != TransferPhase.DONE) TextButton(enabled = !transfers.busy, onClick = {
                        val file = manager.retryDownload
                        if (file == null) manager.retry() else transfers.saveFile(file)
                    }) { Text(stringResource(R.string.transfer_retry)) }
                }
            }
        }
    }
}
