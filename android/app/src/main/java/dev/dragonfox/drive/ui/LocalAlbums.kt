package dev.dragonfox.drive.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.selection.triStateToggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.sync.FolderScanner
import dev.dragonfox.drive.sync.MediaBucket
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import java.io.File

/** A saved recursive rule covers every visible item even when a shallower
 * scan limit makes this directory a direct-only album. */
internal fun MediaBucket.fullySelected(paths: Set<String>, recursivePaths: Set<String>): Boolean {
    val path = directory.absolutePath
    return path in paths && (!recursive || path in recursivePaths)
}

@Composable
internal fun AlbumGrid(albums: List<MediaBucket>, selection: Set<String>, recursive: Set<String>, state: LazyGridState,
    onOpen: (MediaBucket) -> Unit, onToggle: (MediaBucket) -> Unit, modifier: Modifier = Modifier) {
    val duplicateNames = remember(albums) {
        albums.groupingBy { it.directory.name }.eachCount().filterValues { it > 1 }.keys
    }
    val selectedAncestors = remember(selection) {
        selection.flatMap { path -> generateSequence(File(path).parentFile) { it.parentFile }.map { it.absolutePath }.toList() }.toSet()
    }
    LazyVerticalGrid(GridCells.Adaptive(100.dp), modifier.testTag("local-albums"), state = state,
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        items(albums, key = { it.directory.absolutePath }) { album ->
            val path = album.directory.absolutePath
            val name = album.directory.name.ifEmpty { path }
            val explicit = path in selection
            val checked = album.fullySelected(selection, recursive)
            val includedByParent = generateSequence(album.directory.parentFile) { it.parentFile }.any { it.absolutePath in recursive }
            val partial = !checked && (explicit || includedByParent || album.recursive && path in selectedAncestors)
            val state = when { checked -> ToggleableState.On; partial -> ToggleableState.Indeterminate; else -> ToggleableState.Off }
            Column(Modifier.testTag("local-album:$path").clickable { onOpen(album) }) {
                Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(18.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
                    AlbumCover(album.covers)
                    val description = label(R.string.df_select_album, name)
                    Box(Modifier.align(Alignment.TopEnd).size(48.dp).testTag("local-select:$path")
                        .semantics { contentDescription = description }
                        .triStateToggleable(state, role = Role.Checkbox) { onToggle(album) }
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
                if (name in duplicateNames) Text(album.directory.parent.orEmpty(), maxLines = 1,
                    overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    val columns = if (cover.size <= 2) cover.map { listOf(it) } else cover.chunked(2)
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
        for (column in columns) Column(Modifier.weight(1f).fillMaxHeight(),
            verticalArrangement = Arrangement.spacedBy(1.dp)) {
            for (file in column) LocalMediaThumbnail(file, Modifier.fillMaxWidth().weight(1f)
                .testTag("local-cover:${file.absolutePath}"))
        }
    }
}

@Composable
internal fun AlbumContents(album: MediaBucket, scanner: FolderScanner, onOpen: (File) -> Unit) {
    val context = LocalContext.current
    val files = remember(album) { mutableStateListOf<File>() }
    var more by remember(album) { mutableStateOf(true) }
    var error by remember(album) { mutableStateOf<String?>(null) }
    var retry by remember(album) { mutableIntStateOf(0) }
    val state = rememberLazyGridState()
    // Keep the loading effect outside the lazy footer: scrolling the footer off
    // screen should never drop a fetched page or reset the scanner's cursor.
    val nearEnd by remember {
        derivedStateOf { files.isEmpty() || (state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1) >= files.lastIndex - 9 }
    }
    LaunchedEffect(album, retry) {
        try {
            while (more) {
                snapshotFlow { nearEnd }.first { it }
                val page = scanner.mediaPage(album, files.size, 60)
                more = page.size == 60
                files.addAll(page)
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        }
    }
    LazyVerticalGrid(GridCells.Adaptive(100.dp), Modifier.fillMaxSize().testTag("local-media"), state = state,
        contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp)) {
        items(files, key = { it.absolutePath }) { file ->
            val description = file.name
            Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(10.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerHighest).testTag("local-item:${file.absolutePath}")
                .semantics { contentDescription = description }.clickable { onOpen(file) }) {
                LocalMediaThumbnail(file, Modifier.fillMaxSize())
                if (scanner.mime(file).startsWith("video/")) {
                    Icon(Icons.Default.PlayArrow, label(R.string.df_video_clip), Modifier.align(Alignment.BottomStart)
                        .padding(6.dp).size(23.dp).background(Color.Black.copy(alpha = .6f), CircleShape).padding(2.dp),
                        tint = Color.White)
                }
            }
        }
        if (error != null || more || files.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
            when {
                error != null -> RetryLine(error.orEmpty()) { error = null; retry++ }
                more -> LoadingLine()
                else -> Text(label(R.string.df_no_media), Modifier.padding(12.dp))
            }
        }
    }
}
