package dev.dragonfox.drive.ui

import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.transfer.ManualTransfers
import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.LoadedPhoto
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.CloudFolder
import dev.dragonfox.drive.protocol.FolderType
import dev.dragonfox.drive.protocol.shouldShowPhotos
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun CloudBrowser(
    folders: List<CloudFolder>,
    files: List<CloudFile>,
    refresh: suspend () -> Unit,
    changeType: suspend (String, FolderType) -> Unit,
    loadPhoto: suspend (CloudFile, Boolean) -> LoadedPhoto,
    onExit: (() -> Unit)? = null,
    management: HomeManagement? = null,
    transferManager: ManualTransfers? = null,
    itemTool: (@Composable (HomeTool, CloudFile, () -> Unit) -> Unit)? = null,
) {
    var folderId by rememberSaveable { mutableStateOf<String?>(null) }
    var photoId by rememberSaveable { mutableStateOf<String?>(null) }
    val folder = folders.find { it.id == folderId }
    val photo = files.find { it.id == photoId }
    val children = remember(folders, folderId) { folders.filter { it.parentId == folderId }.sortedBy { it.name.lowercase() } }
    val entries = remember(files, folderId) { files.filter { it.parentId == folderId }.sortedBy { it.name.lowercase() } }
    val itemsHere = remember(children, entries) {
        children.map { HomeItem(it.id, true, it.name) } + entries.map { HomeItem(it.id, false, it.name) }
    }
    val gallery = folder != null && shouldShowPhotos(folder.type, entries)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val transfers = transferManager?.let { rememberHomeTransfers(it) }
    var loading by remember { mutableStateOf(true) }
    var changingType by remember { mutableStateOf(false) }
    val pending = management?.submissions?.pending
    val saving = changingType || pending != null
    var wasSubmitted by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var request by remember { mutableIntStateOf(0) }
    var showTypes by remember { mutableStateOf(false) }
    var addMenu by remember { mutableStateOf(false) }
    var rowMenu by remember { mutableStateOf<String?>(null) }
    var selection by rememberSaveable(folderId) { mutableStateOf(arrayListOf<String>()) }
    var action by rememberSaveable(folderId) { mutableStateOf<HomeAction?>(null) }
    var targetKeys by rememberSaveable(folderId) { mutableStateOf(arrayListOf<String>()) }
    var tool by rememberSaveable { mutableStateOf<HomeTool?>(null) }
    var toolTarget by rememberSaveable(stateSaver = toolFileSaver) { mutableStateOf<CloudFile?>(null) }
    val toolFile = toolTarget?.let { target -> files.find { it.id == target.id } ?: target }
    val selectionSet = remember(selection) { selection.toHashSet() }
    val chosen = remember(itemsHere, selectionSet) { itemsHere.filter { it.key in selectionSet } }
    val targets = remember(itemsHere, targetKeys) {
        val keys = targetKeys.toHashSet()
        itemsHere.filter { it.key in keys }
    }
    val selecting = chosen.isNotEmpty()
    var dialogError by rememberSaveable { mutableStateOf<String?>(null) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(pending) {
        if (pending != null) {
            try {
                pending.await()
                selection = arrayListOf()
                error = null
                action = null
                management.newTextBody = ""
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                val message = e.localizedMessage ?: context.getString(R.string.df_request_failed)
                if (e is HomeBatchException) {
                    action = null
                    selection = ArrayList(e.remaining.map { it.key })
                    notice = message
                } else dialogError = message
            }
            wasSubmitted = false
            management.submissions.consume(pending)
        } else if (wasSubmitted) {
            // A process restart loses in-memory acknowledgements. Refresh before another explicit operation.
            wasSubmitted = false
            action = null
            selection = arrayListOf()
            notice = context.getString(R.string.df_home_check_after_restart)
        }
    }
    LaunchedEffect(request) {
        loading = true
        error = null
        try { refresh() }
        catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        } finally { loading = false }
    }
    LaunchedEffect(loading, error, folder, photo) {
        if (!loading && error == null) {
            if (folderId != null && folder == null) folderId = null
            if (photoId != null && photo == null) photoId = null
        }
    }
    fun back() {
        if (photoId != null) photoId = null
        else if (selecting) selection = arrayListOf()
        else if (folderId != null) folderId = folder?.parentId
        else onExit?.invoke()
    }
    fun toggle(item: HomeItem) {
        selection = ArrayList(if (item.key in selection) selection - item.key else selection + item.key)
    }
    fun choose(command: HomeAction, targets: List<HomeItem> = emptyList()) {
        rowMenu = null
        addMenu = false
        val entry = targets.singleOrNull()
        val file = entries.find { it.id == entry?.id }
        when (command) {
            HomeAction.SELECT -> entry?.let(::toggle)
            HomeAction.UPLOAD_FILES -> transfers?.pickFiles(folderId)
            HomeAction.UPLOAD_FOLDER -> transfers?.pickFolder(folderId)
            HomeAction.DOWNLOAD -> file?.let { transfers?.saveFile(it) }
            HomeAction.SHARE, HomeAction.EDIT -> {
                toolTarget = file
                tool = if (command == HomeAction.SHARE) HomeTool.SHARE else HomeTool.EDIT_TEXT
            }
            else -> {
                if (command == HomeAction.TEXT) management?.newTextBody = ""
                notice = null
                dialogError = null
                targetKeys = ArrayList(targets.map { it.key })
                action = command
            }
        }
    }
    val canGoBack = photoId != null || folderId != null || selecting || onExit != null
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
        if (selecting) {
            HomeHeader(label(R.string.df_home_selected, chosen.size), ::back) {
                IconButton(onClick = {
                    selection = if (chosen.size == itemsHere.size) arrayListOf() else ArrayList(itemsHere.map { it.key })
                }, modifier = Modifier.testTag("home-select-all")) {
                    Icon(painterResource(R.drawable.df_home_select_all),
                        label(if (chosen.size == itemsHere.size) R.string.df_home_clear else R.string.df_home_select_all))
                }
                IconButton(onClick = { choose(HomeAction.MOVE, chosen) }, modifier = Modifier.testTag("home-move")) {
                    Icon(painterResource(R.drawable.df_home_move), label(R.string.df_home_move))
                }
                IconButton(onClick = { choose(HomeAction.DELETE, chosen) }, modifier = Modifier.testTag("home-delete")) {
                    Icon(Icons.Outlined.Delete, label(R.string.df_home_delete), tint = MaterialTheme.colorScheme.error)
                }
            }
        } else {
            HomeHeader(folder?.name ?: label(R.string.df_root), if (canGoBack) ::back else null) {
                if (folder != null) Box {
                    IconButton(onClick = { showTypes = true }, enabled = !loading && !saving) {
                        Icon(Icons.Outlined.MoreVert, label(R.string.df_folder_display))
                    }
                    DropdownMenu(expanded = showTypes, onDismissRequest = { showTypes = false }) {
                        FolderType.entries.forEach { option ->
                            DropdownMenuItem(text = { Text(label(option.labelId())) },
                                leadingIcon = { RadioButton(selected = option == folder.type, onClick = null) },
                                onClick = {
                                    showTypes = false
                                    if (option != folder.type) scope.launch {
                                        changingType = true
                                        error = null
                                        try { changeType(folder.id, option) }
                                        catch (e: Exception) {
                                            if (e is CancellationException) throw e
                                            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
                                        } finally { changingType = false }
                                    }
                                })
                        }
                    }
                }
                IconButton(onClick = { notice = null; request++ }, enabled = !loading && !saving) {
                    Icon(Icons.Outlined.Refresh, label(R.string.df_gallery_refresh))
                }
                if (management != null) Box {
                    FilledTonalIconButton(onClick = { addMenu = true }, enabled = !loading && !saving,
                        modifier = Modifier.testTag("home-add")) { Icon(Icons.Outlined.Add, label(R.string.df_home_add)) }
                    DropdownMenu(addMenu, onDismissRequest = { addMenu = false }) {
                        HomeMenuAction(HomeAction.FOLDER) { choose(HomeAction.FOLDER) }
                        HomeMenuAction(HomeAction.TEXT) { choose(HomeAction.TEXT) }
                        if (transfers != null) {
                            HorizontalDivider()
                            HomeMenuAction(HomeAction.UPLOAD_FILES, !transfers.busy) { choose(HomeAction.UPLOAD_FILES) }
                            HomeMenuAction(HomeAction.UPLOAD_FOLDER, !transfers.busy) { choose(HomeAction.UPLOAD_FOLDER) }
                        }
                    }
                }
            }
        }
        if (folder != null) Text(remoteLabel(folder.id, folders),
            Modifier.padding(start = 18.dp, end = 18.dp, bottom = 8.dp),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (loading || saving) LinearProgressIndicator(Modifier.fillMaxWidth())
        (error ?: notice)?.let { message ->
            Text(message, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.error)
        }
        if (transferManager != null && transfers != null) TransferPanel(transferManager, transfers)
        if (!loading && error == null && entries.isEmpty() && children.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(label(R.string.df_empty_drive_folder)) }
        } else {
            val row: @Composable (HomeItem, CloudFile?, Boolean) -> Unit = { item, file, tile ->
                val checked = item.key in selectionSet
                val open: () -> Unit = {
                    when {
                        selecting -> toggle(item)
                        item.isFolder -> folderId = item.id
                        file?.isImage == true -> photoId = item.id
                        file != null && itemTool != null && canEditHomeFile(file) -> choose(HomeAction.EDIT, listOf(item))
                        management != null -> rowMenu = item.key
                    }
                }
                val enabled = !saving && !loading
                val gestures = Modifier.testTag("home-row-" + item.id)
                    .combinedClickable(enabled = enabled, onLongClick = management?.let { { toggle(item) } },
                        onLongClickLabel = label(R.string.df_home_select), onClick = open)
                    .semantics { if (selecting) selected = checked }
                val accessory: @Composable () -> Unit = {
                    if (selecting) Checkbox(checked, onCheckedChange = null)
                    else if (management != null) HomeMore(item, rowMenu == item.key, enabled,
                        { rowMenu = if (it) item.key else null }, file != null && itemTool != null && canEditHomeFile(file),
                        file != null && itemTool != null, file != null && transfers != null, transfers?.busy == true,
                        onAction = { command -> choose(command, listOf(item)) })
                    else if (!tile && (item.isFolder || file?.isImage == true))
                        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null)
                }
                if (tile && file != null) PhotoTile(file, loadPhoto, gestures, accessory, selecting || management != null)
                else ListItem(headlineContent = { Text(item.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    colors = ListItemDefaults.colors(containerColor = if (checked) MaterialTheme.colorScheme.secondaryContainer
                        else MaterialTheme.colorScheme.surface),
                    supportingContent = file?.let { { Text(Formatter.formatShortFileSize(context, it.size)) } },
                    leadingContent = { Icon(painterResource(if (item.isFolder) R.drawable.df_folder else R.drawable.df_local_file),
                        null, tint = if (item.isFolder) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) },
                    trailingContent = accessory, modifier = gestures)
            }
            LazyVerticalGrid(columns = GridCells.Adaptive(116.dp), state = grid, contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                items(children, key = { "folder-" + it.id }, span = { GridItemSpan(maxLineSpan) }) { child ->
                    row(HomeItem(child.id, true, child.name), null, false)
                }
                if (gallery) {
                    val images = entries.filter { it.isImage }
                    val others = entries.filterNot { it.isImage }
                    if (images.isNotEmpty()) {
                        item(span = { GridItemSpan(maxLineSpan) }) { GroupLabel(label(R.string.df_photos)) }
                        items(images, key = { it.id }) { file -> row(HomeItem(file.id, false, file.name), file, true) }
                    }
                    if (others.isNotEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { GroupLabel(label(R.string.df_other_files)) }
                    items(others, key = { it.id }, span = { GridItemSpan(maxLineSpan) }) { file ->
                        row(HomeItem(file.id, false, file.name), file, false)
                    }
                } else items(entries, key = { it.id }, span = { GridItemSpan(maxLineSpan) }) { file ->
                    row(HomeItem(file.id, false, file.name), file, false)
                }
            }
        }
    }
    val command = action
    if (command != null && management != null) key(command, targetKeys) {
        HomeActionDialog(command, targets, folders, folderId, saving, dialogError, management, dismiss = {
            action = null
            if (command == HomeAction.TEXT) management.newTextBody = ""
        }) { name, dest ->
            if (!saving) {
                val source = folderId
                val body = management.newTextBody
                dialogError = null
                wasSubmitted = true
                management.submissions.submit {
                    when (command) {
                        HomeAction.FOLDER -> management.createFolder(source, name)
                        HomeAction.TEXT -> management.createText(source, name, body)
                        HomeAction.RENAME -> management.rename(targets.single(), name)
                        HomeAction.MOVE -> management.move(targets, dest)
                        HomeAction.DELETE -> management.delete(targets)
                        else -> throw IllegalStateException("Unexpected action")
                    }
                }
            }
        }
    }
    val openTool = tool
    if (openTool != null && toolFile != null && itemTool != null)
        key(toolFile.id, openTool) { itemTool(openTool, toolFile) { tool = null; toolTarget = null } }
}

// Keep the editor and its draft open if a refresh moves or removes the original row.
private val toolFileSaver = listSaver<CloudFile?, Any>(
    save = { file -> if (file == null) emptyList() else listOf(file.id, file.parentId.orEmpty(), file.name,
        file.size, file.sha256.orEmpty(), file.revision, file.mime, file.createdAt.orEmpty()) },
    restore = { fields -> if (fields.isEmpty()) null else CloudFile(fields[0] as String,
        (fields[1] as String).ifEmpty { null }, fields[2] as String, fields[3] as Long,
        (fields[4] as String).ifEmpty { null }, fields[5] as String, fields[6] as String,
        (fields[7] as String).ifEmpty { null }) },
)

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
private fun PhotoTile(file: CloudFile, load: suspend (CloudFile, Boolean) -> LoadedPhoto, gestures: Modifier, accessory: @Composable () -> Unit, showAccessory: Boolean) {
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
        .background(MaterialTheme.colorScheme.surfaceVariant).then(gestures),
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
        if (showAccessory) Surface(Modifier.align(Alignment.TopEnd).padding(3.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = .91f), shape = RoundedCornerShape(50)) {
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { accessory() }
        }
    }
}
