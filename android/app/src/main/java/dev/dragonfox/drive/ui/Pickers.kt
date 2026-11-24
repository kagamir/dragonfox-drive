package dev.dragonfox.drive.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.sync.FolderScanner
import dev.dragonfox.drive.sync.SyncMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

@Composable
internal fun LocalPicker(initialMode: SyncMode, previous: Set<String>, allowed: Boolean, request: () -> Unit,
    onBack: () -> Unit, onDone: (SyncMode, Set<String>) -> Unit) {
    val context = LocalContext.current
    val scanner = remember { FolderScanner(context.applicationContext) }
    var modeName by rememberSaveable { mutableStateOf(initialMode.name) }
    val mode = SyncMode.valueOf(modeName)
    var mediaSelection by rememberSaveable { mutableStateOf(ArrayList(if (initialMode == SyncMode.MEDIA) previous else emptySet())) }
    var allSelection by rememberSaveable { mutableStateOf(ArrayList(if (initialMode == SyncMode.ALL) previous else emptySet())) }
    val selection = if (mode == SyncMode.MEDIA) mediaSelection else allSelection
    var history by rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    val current = history.lastOrNull()
    var folders by remember { mutableStateOf<List<File>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    fun up() {
        if (mode == SyncMode.ALL && history.isNotEmpty()) history = ArrayList(history.dropLast(1))
        else onBack()
    }
    BackHandler(mode == SyncMode.ALL && history.isNotEmpty()) { up() }
    LaunchedEffect(mode, current, allowed, refresh) {
        folders = emptyList()
        error = null
        loading = allowed
        if (!allowed) return@LaunchedEffect
        try {
            folders = withContext(Dispatchers.IO) {
                if (mode == SyncMode.MEDIA) scanner.mediaFolders()
                else if (current == null) scanner.roots() else scanner.children(File(current))
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        } finally { loading = false }
    }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Header(label(R.string.df_choose_local), ::up)
        Column(Modifier.widthIn(max = 740.dp).fillMaxWidth().padding(horizontal = 16.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SyncMode.entries.forEach { option ->
                    FilterChip(selected = mode == option, onClick = { modeName = option.name },
                        label = { Text(label(if (option == SyncMode.MEDIA) R.string.df_media else R.string.df_all_files)) })
                }
            }
            Text(if (mode == SyncMode.MEDIA) label(R.string.df_media_hint) else current ?: label(R.string.df_all_hint),
                Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(Modifier.widthIn(max = 740.dp).fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            when {
                !allowed -> item { PermissionPanel(request) }
                loading -> item { LoadingLine() }
                error != null -> item { RetryLine(error.orEmpty()) { refresh++ } }
                folders.isEmpty() -> item { Text(label(if (mode == SyncMode.MEDIA) R.string.df_no_media else R.string.df_empty_folder)) }
                else -> items(folders, key = { it.absolutePath }) { folder ->
                    val path = folder.absolutePath
                    val checked = path in selection
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.weight(1f).toggleable(value = checked, role = Role.Checkbox) { selected ->
                            val updated = ArrayList(if (selected) selection + path else selection - path)
                            if (mode == SyncMode.MEDIA) mediaSelection = updated else allSelection = updated
                        }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Checkbox(checked, onCheckedChange = null)
                            Column {
                                Text(folder.name.ifEmpty { path }, fontWeight = FontWeight.Medium)
                                Text(path, style = MaterialTheme.typography.bodySmall, maxLines = 2,
                                    overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        if (mode == SyncMode.ALL) IconButton(onClick = { history = ArrayList(history + path) }) {
                            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, label(R.string.df_open_folder, folder.name))
                        }
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
        Button(onClick = { onDone(mode, selection.toSet()) }, enabled = allowed,
            modifier = Modifier.widthIn(max = 740.dp).fillMaxWidth().padding(16.dp)) {
            Text(label(R.string.df_use_selected, selection.size))
        }
    }
}

@Composable
private fun LoadingLine() {
    Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) {
        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
    }
}

@Composable
private fun RetryLine(error: String, retry: () -> Unit) {
    Text(error, color = MaterialTheme.colorScheme.error)
    TextButton(onClick = retry) { Text(label(R.string.df_retry)) }
}

@Composable
internal fun CloudPicker(model: DriveModel, initial: String?, onBack: () -> Unit, onDone: (String?) -> Unit) {
    val context = LocalContext.current
    var active by rememberSaveable { mutableStateOf(initial) }
    val folders = model.cloudFolders
    var refresh by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(refresh) {
        loading = true; error = null
        try {
            model.refreshFolders()
            if (active != null && model.cloudFolders.none { it.id == active }) active = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        } finally { loading = false }
    }
    val children = remember(active, folders) { folders.filter { it.parentId == active }.sortedBy { it.name.lowercase() } }
    fun up() {
        if (active == null) onBack()
        else active = folders.find { it.id == active }?.parentId
    }
    BackHandler(active != null) { up() }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Header(label(R.string.df_choose_cloud), ::up)
        Text(remoteLabel(active, folders), Modifier.widthIn(max = 740.dp).fillMaxWidth().padding(16.dp),
            style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
        LazyColumn(Modifier.widthIn(max = 740.dp).fillMaxWidth().weight(1f), contentPadding = PaddingValues(horizontal = 16.dp)) {
            when {
                loading -> item { LoadingLine() }
                error != null -> item { RetryLine(error.orEmpty()) { refresh++ } }
                children.isEmpty() -> item { Text(label(R.string.df_no_subfolders), style = MaterialTheme.typography.bodyMedium) }
                else -> items(children, key = { it.id }) { folder ->
                    ListItem(headlineContent = { Text(folder.name) }, leadingContent = { Icon(painterResource(R.drawable.df_folder), null) },
                        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                        modifier = Modifier.fillMaxWidth().clickable { active = folder.id })
                    HorizontalDivider()
                }
            }
        }
        Button(onClick = { onDone(active) }, enabled = !loading && error == null,
            modifier = Modifier.widthIn(max = 740.dp).fillMaxWidth().padding(16.dp)) { Text(label(R.string.df_use_destination)) }
    }
}
