package dev.dragonfox.drive.ui

import android.text.format.Formatter
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.dragonfox.drive.R
import dev.dragonfox.drive.sync.FolderScanner
import dev.dragonfox.drive.sync.LocalEntry
import kotlinx.coroutines.CancellationException
import java.io.File

private sealed interface DirectoryListing {
    data object Loading : DirectoryListing
    data class Loaded(val entries: List<LocalEntry>) : DirectoryListing
    data class Failed(val message: String) : DirectoryListing
}

@Composable
internal fun AllFilesBrowser(scanner: FolderScanner, directory: String?, maxDepth: Int,
    selection: Set<String>, scrollHistory: SaveableStateHolder, onEnter: (String) -> Unit,
    onUp: () -> Unit, onChecked: (String, Boolean) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var attempt by remember(directory) { mutableIntStateOf(0) }
    var listing by remember(scanner, directory, maxDepth, attempt) {
        mutableStateOf<DirectoryListing>(DirectoryListing.Loading)
    }
    var previewPath by rememberSaveable(directory, maxDepth) { mutableStateOf<String?>(null) }
    LaunchedEffect(scanner, directory, maxDepth, attempt) {
        listing = try {
            DirectoryListing.Loaded(scanner.directoryEntries(directory?.let(::File), maxDepth))
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            DirectoryListing.Failed(e.localizedMessage ?: context.getString(R.string.df_request_failed))
        }
    }
    Column(modifier) {
        if (directory != null) {
            Row(Modifier.fillMaxWidth().testTag("local-parent").clickable(onClick = onUp)
                .heightIn(min = 52.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, null, tint = MaterialTheme.colorScheme.primary)
                Text(label(R.string.df_local_parent), style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
        when (val page = listing) {
            DirectoryListing.Loading -> LoadingLine()
            is DirectoryListing.Failed -> Column(Modifier.padding(16.dp).testTag("local-list-error")) {
                RetryLine(page.message) { attempt++ }
            }
            is DirectoryListing.Loaded -> if (page.entries.isEmpty()) {
                Text(label(if (directory == null) R.string.df_no_local_volumes else R.string.df_no_local_entries),
                    Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else scrollHistory.SaveableStateProvider(directory ?: "volumes") {
                LazyColumn(Modifier.fillMaxSize().testTag("local-folders")) {
                    items(page.entries, key = { it.file.absolutePath }) { entry ->
                        val path = entry.file.absolutePath
                        val open = { if (entry.isDirectory) onEnter(path) else previewPath = path }
                        EntryRow(entry, directory == null, path in selection, open) { checked -> onChecked(path, checked) }
                        HorizontalDivider(Modifier.padding(start = 68.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }
    val path = previewPath
    if (path != null && directory != null && File(path).parent == directory) {
        Dialog(onDismissRequest = { previewPath = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Surface(Modifier.fillMaxSize()) {
                CheckedFilePreview(scanner, File(path), maxDepth) { previewPath = null }
            }
        }
    }
}

@Composable
private fun EntryRow(entry: LocalEntry, isVolume: Boolean, checked: Boolean, onOpen: () -> Unit,
    onChecked: (Boolean) -> Unit) {
    val path = entry.file.absolutePath
    val name = entry.file.name.ifEmpty { path }
    val rowTag = if (entry.isDirectory) "local-open:$path" else "local-file:$path"
    Row(Modifier.fillMaxWidth().testTag(rowTag).clickable(onClick = onOpen)
        .heightIn(min = 62.dp).padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        val icon = Modifier.size(40.dp).clip(RoundedCornerShape(9.dp))
        if (!entry.isDirectory && (entry.mime.startsWith("image/") || entry.mime.startsWith("video/"))) {
            LocalMediaThumbnail(entry.file, icon)
        } else {
            Surface(icon, color = if (entry.isDirectory) MaterialTheme.colorScheme.primaryContainer
                else MaterialTheme.colorScheme.surfaceContainerHigh) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(painterResource(if (entry.isDirectory) R.drawable.df_folder else R.drawable.df_local_file),
                        null, Modifier.size(22.dp))
                }
            }
        }
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (isVolume) Text(path, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            else if (!entry.isDirectory && entry.size != null) {
                Text(Formatter.formatShortFileSize(LocalContext.current, entry.size),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (entry.isDirectory) {
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            val description = label(R.string.df_select_folder, name)
            Checkbox(checked = checked, onCheckedChange = onChecked,
                modifier = Modifier.testTag("local-select:$path").semantics { contentDescription = description })
        }
    }
}

/** A row may have changed between listing and opening, including across rotation. */
@Composable
private fun CheckedFilePreview(scanner: FolderScanner, file: File, maxDepth: Int, onBack: () -> Unit) {
    val context = LocalContext.current
    var attempt by remember(file) { mutableIntStateOf(0) }
    var entry by remember(scanner, file, maxDepth, attempt) { mutableStateOf<LocalEntry?>(null) }
    var error by remember(scanner, file, maxDepth, attempt) { mutableStateOf<String?>(null) }
    LaunchedEffect(scanner, file, maxDepth, attempt) {
        try {
            entry = scanner.fileEntry(file, maxDepth)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        }
    }
    val current = entry
    if (current != null) LocalFilePreview(current.file, current.mime, onBack)
    else Column(Modifier.fillMaxSize()) {
        Header(file.name, onBack)
        val message = error
        if (message == null) LoadingLine()
        else Column(Modifier.padding(16.dp).testTag("local-open-error")) { RetryLine(message) { attempt++ } }
    }
}
