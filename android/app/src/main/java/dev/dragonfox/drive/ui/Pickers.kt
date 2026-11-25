package dev.dragonfox.drive.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.sync.FolderScanner
import dev.dragonfox.drive.sync.MediaBucket
import dev.dragonfox.drive.sync.storageDepth
import dev.dragonfox.drive.sync.SyncMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun LocalPicker(initialMode: SyncMode, previous: Set<String>, previousRecursive: Set<String>,
    maxDepth: Int, allowed: Boolean, request: () -> Unit, onBack: () -> Unit, scanner: FolderScanner? = null,
    onDone: (SyncMode, Set<String>, Set<String>) -> Unit) {
    val context = LocalContext.current
    val source = remember(scanner, context) { scanner ?: FolderScanner(context.applicationContext) }
    var modeName by rememberSaveable { mutableStateOf(initialMode.name) }
    val mode = SyncMode.valueOf(modeName)
    var mediaPaths by rememberSaveable { mutableStateOf(ArrayList(if (initialMode == SyncMode.MEDIA) previous else emptySet())) }
    var recursivePaths by rememberSaveable { mutableStateOf(ArrayList(if (initialMode == SyncMode.MEDIA) previousRecursive.intersect(previous) else emptySet())) }
    var allPaths by rememberSaveable { mutableStateOf(ArrayList(if (initialMode == SyncMode.ALL) previous else emptySet())) }
    val selection = remember(mode, mediaPaths, allPaths) { (if (mode == SyncMode.MEDIA) mediaPaths else allPaths).toSet() }
    val recursive = remember(mode, recursivePaths, allPaths) { (if (mode == SyncMode.MEDIA) recursivePaths else allPaths).toSet() }
    var scanRoots by remember(source, allowed, maxDepth) { mutableStateOf<List<File>>(emptyList()) }
    val activeSelection = remember(selection, scanRoots, maxDepth) {
        selection.filterTo(mutableSetOf()) { (storageDepth(File(it), scanRoots) ?: Int.MAX_VALUE) <= maxDepth }
    }
    var history by rememberSaveable(maxDepth) { mutableStateOf(arrayListOf<String>()) }
    val current = history.lastOrNull()
    var albums by remember(maxDepth) { mutableStateOf<List<MediaBucket>>(emptyList()) }
    var openAlbum by rememberSaveable(maxDepth) { mutableStateOf<String?>(null) }
    val album = remember(openAlbum, albums) { albums.find { it.directory.absolutePath == openAlbum } }
    var manage by rememberSaveable { mutableStateOf(false) }
    val directoryScroll = rememberSaveableStateHolder()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    val albumScroll = rememberLazyGridState()
    fun up() {
        when {
            mode == SyncMode.MEDIA && openAlbum != null -> openAlbum = null
            mode == SyncMode.ALL && history.isNotEmpty() -> history = ArrayList(history.dropLast(1))
            else -> onBack()
        }
    }
    fun select(paths: Set<String>, recursiveSelection: Set<String>) {
        if (mode == SyncMode.ALL) allPaths = ArrayList(paths)
        else {
            mediaPaths = ArrayList(paths)
            recursivePaths = ArrayList(recursiveSelection.intersect(paths))
        }
    }
    BackHandler(mode == SyncMode.MEDIA && openAlbum != null || mode == SyncMode.ALL && history.isNotEmpty()) { up() }
    LaunchedEffect(mode, source, allowed, maxDepth, refresh) {
        error = null
        loading = allowed
        if (!allowed) {
            albums = emptyList()
            return@LaunchedEffect
        }
        try {
            scanRoots = withContext(Dispatchers.IO) { source.roots() }
            if (mode == SyncMode.MEDIA) {
                albums = source.mediaBuckets(maxDepth)
                if (openAlbum != null && albums.none { it.directory.absolutePath == openAlbum }) openAlbum = null
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        } finally { loading = false }
    }
    val inAlbum = allowed && !loading && error == null && mode == SyncMode.MEDIA && album != null
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (inAlbum) {
            key(album!!.directory.absolutePath, maxDepth) {
                AlbumContents(album, source, ::up)
            }
        } else {
            Header(label(R.string.df_choose_local), ::up)
            Column(Modifier.widthIn(max = 840.dp).fillMaxWidth().padding(horizontal = 16.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SyncMode.entries.forEach { option ->
                        FilterChip(selected = mode == option, onClick = { modeName = option.name; openAlbum = null },
                            label = { Text(label(if (option == SyncMode.MEDIA) R.string.df_media else R.string.df_all_files)) })
                    }
                }
                Text(if (mode == SyncMode.MEDIA) label(R.string.df_media_hint) else current ?: label(R.string.df_all_hint),
                    Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodySmall,
                    maxLines = if (mode == SyncMode.ALL && current != null) 2 else Int.MAX_VALUE,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (mode == SyncMode.MEDIA && allowed && albums.isNotEmpty() && !loading && error == null) {
                        TextButton(onClick = {
                            val newlySelected = albums.filterNot { it.fullySelected(selection, recursive) || it.inheritedFrom(recursive) }
                            val paths = newlySelected.map { it.directory.absolutePath }
                            val subtrees = newlySelected.filter { it.recursive }.map { it.directory.absolutePath }
                            select(selection + paths, recursive + subtrees)
                        }) { Text(label(R.string.df_album_select_all)) }
                    }
                    if (selection.isNotEmpty()) {
                        TextButton(onClick = { select(emptySet(), emptySet()) }) { Text(label(R.string.df_album_clear)) }
                        TextButton(onClick = { manage = true }) { Text(label(R.string.df_manage_selection, selection.size)) }
                    }
                }
            }
            val content = Modifier.widthIn(max = 840.dp).fillMaxWidth().weight(1f)
            when {
                !allowed -> Box(content) { PermissionPanel(request) }
                mode == SyncMode.ALL -> AllFilesBrowser(source, current, maxDepth, selection, directoryScroll,
                    onEnter = { path -> if (history.lastOrNull() != path) history = ArrayList(history + path) },
                    onUp = ::up, onChecked = { path, checked ->
                        allPaths = ArrayList(if (checked) selection + path else selection - path)
                    }, modifier = content)
                loading -> Box(content) { LoadingLine() }
                error != null -> Column(content.padding(16.dp)) { RetryLine(error.orEmpty()) { refresh++ } }
                albums.isEmpty() -> Text(label(R.string.df_no_media), content.padding(16.dp))
                else -> AlbumGrid(albums, activeSelection, recursive.intersect(activeSelection), albumScroll, { openAlbum = it.directory.absolutePath }, { item ->
                    val path = item.directory.absolutePath
                    if (item.fullySelected(selection, recursive)) {
                        val remove = item.rulesToClear(activeSelection)
                        select(selection - remove, recursive - remove)
                    } else select(selection + path, if (item.recursive) recursive + path else recursive)
                }, { manage = true }, content)
            }
            Button(onClick = { onDone(mode, selection, recursive) }, enabled = allowed,
                modifier = Modifier.widthIn(max = 840.dp).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text(label(R.string.df_use_selected, activeSelection.size))
            }
        }
    }
    if (manage) AlertDialog(onDismissRequest = { manage = false }, title = { Text(label(R.string.df_manage_selection, selection.size)) },
        text = {
            LazyColumn {
                items(selection.sorted(), key = { it }) { path ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(path, style = MaterialTheme.typography.bodyMedium)
                            val depth = storageDepth(File(path), scanRoots)
                            Text(label(when {
                                depth == null -> R.string.df_album_unavailable
                                depth > maxDepth -> R.string.df_album_outside_depth
                                path in recursive -> R.string.df_album_recursive
                                else -> R.string.df_album_direct
                            }), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { select(selection - path, recursive - path) }) { Text(label(R.string.df_album_remove)) }
                    }
                }
            }
        }, confirmButton = { TextButton(onClick = { manage = false }) { Text(label(R.string.df_album_done)) } })
}

@Composable
internal fun LoadingLine() {
    Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) {
        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
    }
}

@Composable
internal fun RetryLine(error: String, retry: () -> Unit) {
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
