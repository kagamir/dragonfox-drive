package dev.dragonfox.drive.ui

import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.LoadedPhoto
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.CloudFolder
import dev.dragonfox.drive.protocol.FolderType
import dev.dragonfox.drive.protocol.shouldShowPhotos
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun CloudBrowser(
    folders: List<CloudFolder>,
    files: List<CloudFile>,
    refresh: suspend () -> Unit,
    changeType: suspend (String, FolderType) -> Unit,
    loadPhoto: suspend (CloudFile, Boolean) -> LoadedPhoto,
    onExit: (() -> Unit)? = null,
) {
    var folderId by rememberSaveable { mutableStateOf<String?>(null) }
    var photoId by rememberSaveable { mutableStateOf<String?>(null) }
    val folder = folders.find { it.id == folderId }
    val photo = files.find { it.id == photoId }
    val children = remember(folders, folderId) { folders.filter { it.parentId == folderId }.sortedBy { it.name.lowercase() } }
    val entries = remember(files, folderId) { files.filter { it.parentId == folderId }.sortedBy { it.name.lowercase() } }
    val gallery = folder != null && shouldShowPhotos(folder.type, entries)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var request by remember { mutableIntStateOf(0) }
    var showTypes by remember { mutableStateOf(false) }
    LaunchedEffect(request) {
        loading = true
        error = null
        try { refresh() }
        catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        } finally { loading = false }
    }
    // A saved navigation destination can have been removed by another client.
    LaunchedEffect(loading, error, folder, photo) {
        if (!loading && error == null) {
            if (folderId != null && folder == null) folderId = null
            if (photoId != null && photo == null) photoId = null
        }
    }
    fun back() {
        if (photoId != null) photoId = null
        else if (folderId != null) folderId = folder?.parentId
        else onExit?.invoke()
    }
    val canGoBack = photoId != null || folderId != null || onExit != null
    BackHandler(enabled = canGoBack, onBack = ::back)
    val grid = key(folderId) { rememberLazyGridState() }
    if (photo != null) {
        val images = remember(entries) { entries.filter { it.isImage } }
        val index = images.indexOfFirst { it.id == photo.id }
        val navigation = if (images.size > 1 && index >= 0) MediaNavigation(index, images.size,
            images.getOrNull(index - 1)?.let { before -> { photoId = before.id } },
            images.getOrNull(index + 1)?.let { after -> { photoId = after.id } }) else null
        key(photo.id) { PhotoDetail(photo, loadPhoto, navigation, onBack = ::back) }
        return
    }
    Column(Modifier.fillMaxSize()) {
        Header(folder?.name ?: label(R.string.df_root), if (canGoBack) ::back else null) {
            if (folder != null) Box {
                IconButton(onClick = { showTypes = true }, enabled = !loading && !saving) {
                    Icon(Icons.Outlined.MoreVert, label(R.string.df_folder_display))
                }
                DropdownMenu(expanded = showTypes, onDismissRequest = { showTypes = false }) {
                    FolderType.entries.forEach { option ->
                        DropdownMenuItem(
                            text = { Text(label(option.labelId())) },
                            leadingIcon = {
                                RadioButton(selected = option == folder.type, onClick = null)
                            },
                            onClick = {
                                showTypes = false
                                if (option != folder.type) scope.launch {
                                    saving = true
                                    error = null
                                    try { changeType(folder.id, option) }
                                    catch (e: Exception) {
                                        if (e is CancellationException) throw e
                                        error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
                                    } finally { saving = false }
                                }
                            },
                        )
                    }
                }
            }
            IconButton(onClick = { request++ }, enabled = !loading && !saving) {
                Icon(Icons.Outlined.Refresh, label(R.string.df_gallery_refresh))
            }
        }
        if (folder != null) Text(remoteLabel(folder.id, folders),
            Modifier.padding(start = 18.dp, end = 18.dp, bottom = 8.dp),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (loading || saving) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { message ->
            Text(message, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.error)
        }
        if (!loading && error == null && entries.isEmpty() && children.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(label(R.string.df_empty_drive_folder)) }
        } else {
            LazyVerticalGrid(columns = GridCells.Adaptive(116.dp), state = grid, contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                items(children, key = { "folder-" + it.id }, span = { GridItemSpan(maxLineSpan) }) { child ->
                    ListItem(headlineContent = { Text(child.name) }, leadingContent = {
                        Icon(painterResource(R.drawable.df_folder), null, tint = MaterialTheme.colorScheme.primary)
                    }, trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
                        modifier = Modifier.clickable { folderId = child.id })
                }
                if (gallery) {
                    val images = entries.filter { it.isImage }
                    val others = entries.filterNot { it.isImage }
                    if (images.isNotEmpty()) {
                        item(span = { GridItemSpan(maxLineSpan) }) { GroupLabel(label(R.string.df_photos)) }
                        items(images, key = { it.id }) { file ->
                            PhotoTile(file, loadPhoto) { photoId = file.id }
                        }
                    }
                    if (others.isNotEmpty()) {
                        item(span = { GridItemSpan(maxLineSpan) }) { GroupLabel(label(R.string.df_other_files)) }
                        items(others, key = { it.id }, span = { GridItemSpan(maxLineSpan) }) { file -> FileRow(file) }
                    }
                } else {
                    items(entries, key = { it.id }, span = { GridItemSpan(maxLineSpan) }) { file ->
                        FileRow(file, if (file.isImage) ({ photoId = file.id }) else null)
                    }
                }
            }
        }
    }
}

private fun FolderType.labelId() = when (this) {
    FolderType.AUTO -> R.string.df_folder_auto
    FolderType.NORMAL -> R.string.df_folder_normal
    FolderType.PHOTOS -> R.string.df_folder_photos
}

@Composable
private fun GroupLabel(text: String) {
    Text(text, Modifier.padding(top = 8.dp, bottom = 4.dp).semantics { heading() },
        style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun FileRow(file: CloudFile, open: (() -> Unit)? = null) {
    val context = LocalContext.current
    ListItem(headlineContent = { Text(file.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = { Text(Formatter.formatShortFileSize(context, file.size)) },
        trailingContent = if (open != null) ({ Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) }) else null,
        modifier = if (open != null) Modifier.clickable(onClick = open) else Modifier)
}

@Composable
private fun PhotoTile(file: CloudFile, load: suspend (CloudFile, Boolean) -> LoadedPhoto, open: () -> Unit) {
    var picture by remember(file.id, file.revision) { mutableStateOf<LoadedPhoto?>(null) }
    var failed by remember(file.id, file.revision) { mutableStateOf(false) }
    LaunchedEffect(file.id, file.revision) {
        try { picture = load(file, false) }
        catch (e: Exception) {
            if (e is CancellationException) throw e
            failed = true
        }
    }
    Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(10.dp))
        .background(MaterialTheme.colorScheme.surfaceVariant).clickable(onClick = open),
        contentAlignment = Alignment.Center) {
        val bitmap = picture?.bitmap
        if (bitmap != null) Image(bitmap.asImageBitmap(), file.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(8.dp)) {
                if (!failed && picture == null) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(Icons.Outlined.Info, label(R.string.df_no_preview))
                Text(file.name, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
