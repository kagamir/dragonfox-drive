package dev.dragonfox.drive.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.selection.triStateToggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.dragonfox.drive.R
import dev.dragonfox.drive.sync.FolderScanner
import dev.dragonfox.drive.sync.MediaBucket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** A saved recursive rule covers every visible item even when a shallower
 * scan limit makes this directory a direct-only album. */
internal fun MediaBucket.fullySelected(paths: Set<String>, recursivePaths: Set<String>): Boolean {
    val path = directory.absolutePath
    return path in paths && (!recursive || path in recursivePaths)
}

/** Remove the active rules that would continue to select this album after its
 * checkbox is cleared. Inactive rules beyond the scan limit stay in Selected. */
internal fun MediaBucket.rulesToClear(activePaths: Set<String>): Set<String> {
    if (!recursive) return setOf(directory.absolutePath)
    val root = directory.toPath()
    return activePaths.filterTo(mutableSetOf()) { File(it).toPath().startsWith(root) }
}

internal fun MediaBucket.inheritedFrom(recursivePaths: Set<String>): Boolean =
    generateSequence(directory.parentFile) { it.parentFile }.any { it.absolutePath in recursivePaths }

@Composable
internal fun AlbumGrid(albums: List<MediaBucket>, selection: Set<String>, recursive: Set<String>, state: LazyGridState,
    onOpen: (MediaBucket) -> Unit, onToggle: (MediaBucket) -> Unit, onManage: () -> Unit, modifier: Modifier = Modifier) {
    val selectedAncestors = remember(selection) {
        selection.flatMap { path -> generateSequence(File(path).parentFile) { it.parentFile }.map { it.absolutePath }.toList() }.toSet()
    }
    LazyVerticalGrid(GridCells.Adaptive(100.dp), modifier.testTag("local-albums"), state = state,
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        items(albums, key = { it.directory.absolutePath }) { album ->
            val path = album.directory.absolutePath
            val name = album.directory.name.ifEmpty { label(R.string.df_album_storage) }
            val explicit = path in selection
            val includedByParent = album.inheritedFrom(recursive)
            val checked = includedByParent || album.fullySelected(selection, recursive)
            val partial = !checked && (explicit || album.recursive && path in selectedAncestors)
            val state = when { checked -> ToggleableState.On; partial -> ToggleableState.Indeterminate; else -> ToggleableState.Off }
            Column(Modifier.testTag("local-album:$path").clickable { onOpen(album) }) {
                Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(18.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
                    AlbumCover(album.covers)
                    val description = label(if (includedByParent) R.string.df_manage_album_scope else R.string.df_select_album, name)
                    Box(Modifier.align(Alignment.TopEnd).size(48.dp).testTag("local-select:$path")
                        .semantics { contentDescription = description }
                        .triStateToggleable(state, role = Role.Checkbox) { if (includedByParent) onManage() else onToggle(album) }
                        .padding(top = 7.dp, end = 7.dp), contentAlignment = Alignment.TopEnd) {
                        Box(Modifier.size(23.dp).background(
                            if (checked || partial) MaterialTheme.colorScheme.primary else Color.Black.copy(alpha = .35f), CircleShape)
                            .border(1.5.dp, Color.White, CircleShape), contentAlignment = Alignment.Center) {
                            if (checked) Icon(Icons.Default.Check, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onPrimary)
                            else if (partial) Box(Modifier.size(width = 10.dp, height = 2.dp)
                                .background(MaterialTheme.colorScheme.onPrimary, CircleShape))
                        }
                    }
                }
                Text(name, Modifier.padding(top = 5.dp), style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (album.count == 1) label(R.string.df_album_single) else label(R.string.df_album_count, album.count), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                val scope = when {
                    includedByParent -> R.string.df_album_from_parent
                    explicit && !checked -> if (path in recursive) R.string.df_album_recursive else R.string.df_album_direct
                    partial -> R.string.df_album_partial
                    checked && path in recursive -> R.string.df_album_recursive
                    else -> null
                }
                if (scope != null) Text(label(scope), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary)

            }
        }
    }
}

@Composable
private fun AlbumCover(files: List<File>) {
    val cover = files.take(4)
    if (cover.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.df_folder), null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        for (row in cover.chunked(2)) Row(Modifier.fillMaxWidth().weight(1f),
            horizontalArrangement = Arrangement.spacedBy(1.dp)) {
            for (file in row) LocalMediaThumbnail(file, Modifier.weight(1f).fillMaxHeight()
                .testTag("local-cover:${file.absolutePath}"))
        }
    }
}

@Composable
internal fun AlbumContents(album: MediaBucket, scanner: FolderScanner, onBack: () -> Unit) {
    val state = rememberLazyGridState()
    val scope = rememberCoroutineScope()
    var previewIndex by rememberSaveable { mutableIntStateOf(-1) }
    var previewPath by rememberSaveable { mutableStateOf<String?>(null) }
    val index = previewIndex
    val photo = if (index in 0 until album.count) album.fileAt(index).takeIf { it.absolutePath == previewPath } else null
    // A fresh scan after rotation may insert, reorder, or remove files. Restore
    // the original path if it still belongs to this album and scan depth.
    LaunchedEffect(album, previewPath) {
        val path = previewPath ?: return@LaunchedEffect
        if (photo == null) {
            val match = withContext(Dispatchers.Default) {
                (0 until album.count).firstOrNull { album.fileAt(it).absolutePath == path }
            }
            previewIndex = match ?: -1
            if (match == null) previewPath = null
        }
    }
    fun openPreview(target: Int) {
        previewIndex = target
        previewPath = album.fileAt(target).absolutePath
    }
    fun closePreview() {
        val gridIndex = previewIndex + 1 // the first grid item is the album path
        previewIndex = -1
        previewPath = null
        if (state.layoutInfo.visibleItemsInfo.none { it.index == gridIndex }) {
            scope.launch { state.scrollToItem(gridIndex) }
        }
    }
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 4.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, label(R.string.df_back)) }
        Text(album.directory.name.ifEmpty { label(R.string.df_album_storage) },
            Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    LazyVerticalGrid(GridCells.Adaptive(100.dp), Modifier.fillMaxWidth().testTag("local-media"), state = state,
        contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp)) {
        item(span = { GridItemSpan(maxLineSpan) }, key = "album-path") {
            SelectionContainer {
                Text(album.directory.absolutePath, Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, bottom = 10.dp)
                    .testTag("local-album-path"), style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, softWrap = true)
            }
        }
        items(album.count, key = { album.fileAt(it).absolutePath }) { index ->
            val file = album.fileAt(index)
            val description = file.name
            Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(10.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerHighest).testTag("local-item:${file.absolutePath}")
                .semantics { contentDescription = description }.clickable { openPreview(index) }) {
                LocalMediaThumbnail(file, Modifier.fillMaxSize())
                if (scanner.mime(file).startsWith("video/")) {
                    Icon(Icons.Default.PlayArrow, label(R.string.df_video_clip), Modifier.align(Alignment.BottomStart)
                        .padding(6.dp).size(23.dp).background(Color.Black.copy(alpha = .6f), CircleShape).padding(2.dp),
                        tint = Color.White)
                }
            }
        }
    }
    if (photo != null) Dialog(onDismissRequest = ::closePreview,
        properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val controls = MediaNavigation(
            index = index,
            total = album.count,
            onPrevious = if (index > 0) ({ openPreview(index - 1) }) else null,
            onNext = if (index + 1 < album.count) ({ openPreview(index + 1) }) else null,
        )
        Surface(Modifier.fillMaxSize()) { LocalMediaDetail(photo, controls, ::closePreview) }
    }
}
