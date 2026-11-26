package dev.dragonfox.drive.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.protocol.CloudFolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async

internal data class HomeItem(val id: String, val isFolder: Boolean, val name: String) {
    val key: String get() = (if (isFolder) "folder:" else "file:") + id
}

/** Keep the result available while the Home composition is absent (tab switch or rotation). */
internal class HomeSubmissions(private val scope: CoroutineScope) {
    var pending by mutableStateOf<Deferred<Unit>?>(null)
        private set

    fun submit(change: suspend () -> Unit) {
        if (pending == null) pending = scope.async { change() }
    }

    fun consume(request: Deferred<Unit>) {
        if (pending === request) pending = null
    }

    fun clear() {
        pending?.cancel()
        pending = null
    }
}

internal interface HomeManagement {
    val submissions: HomeSubmissions
    var newTextBody: String
    suspend fun createFolder(parentId: String?, name: String)
    suspend fun createText(parentId: String?, name: String, content: String)
    suspend fun rename(item: HomeItem, name: String)
    suspend fun move(items: List<HomeItem>, parentId: String?)
    suspend fun delete(items: List<HomeItem>)
}

internal enum class HomeTool { EDIT_TEXT, SHARE }
internal enum class HomeAction(val label: Int, val tag: String) {
    FOLDER(R.string.df_home_new_folder, "home-new-folder"),
    TEXT(R.string.df_home_new_text, "home-new-text"),
    UPLOAD_FILES(R.string.df_home_upload_files, "home-upload-files"),
    UPLOAD_FOLDER(R.string.df_home_upload_folder, "home-upload-folder"),
    RENAME(R.string.df_home_rename, "home-rename"),
    MOVE(R.string.df_home_move, "home-move"),
    DELETE(R.string.df_home_delete, "home-delete"),
    SELECT(R.string.df_home_select, "home-select"),
    DOWNLOAD(R.string.df_home_download, "home-download"),
    EDIT(R.string.df_home_edit_text, "home-edit"),
    SHARE(R.string.df_home_share, "home-share"),
}

@Composable
internal fun HomeHeader(title: String, back: (() -> Unit)?, actions: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        if (back == null) FoxMark(Modifier.padding(horizontal = 9.dp).size(30.dp))
        else IconButton(onClick = back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, label(R.string.df_back)) }
        Text(title, Modifier.weight(1f).padding(horizontal = 6.dp).semantics { heading() },
            style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        actions()
    }
}

@Composable
internal fun HomeMenuAction(action: HomeAction, enabled: Boolean = true, onClick: () -> Unit) {
    DropdownMenuItem(text = {
        Text(label(action.label), color = if (action == HomeAction.DELETE) MaterialTheme.colorScheme.error else LocalContentColor.current)
    }, enabled = enabled, onClick = onClick, modifier = Modifier.testTag(action.tag))
}

@Composable
internal fun HomeMore(item: HomeItem, expanded: Boolean, enabled: Boolean, onExpand: (Boolean) -> Unit,
    editable: Boolean, share: Boolean, download: Boolean, transferBusy: Boolean, onAction: (HomeAction) -> Unit) {
    Box {
        IconButton(onClick = { onExpand(true) }, enabled = enabled, modifier = Modifier.testTag("home-more-" + item.id)) {
            Icon(Icons.Outlined.MoreVert, label(R.string.df_home_actions_for, item.name))
        }
        DropdownMenu(expanded, onDismissRequest = { onExpand(false) }) {
            fun choose(action: HomeAction) { onExpand(false); onAction(action) }
            if (editable) HomeMenuAction(HomeAction.EDIT) { choose(HomeAction.EDIT) }
            if (download) HomeMenuAction(HomeAction.DOWNLOAD, !transferBusy) { choose(HomeAction.DOWNLOAD) }
            if (share) HomeMenuAction(HomeAction.SHARE) { choose(HomeAction.SHARE) }
            HomeMenuAction(HomeAction.RENAME) { choose(HomeAction.RENAME) }
            HomeMenuAction(HomeAction.MOVE) { choose(HomeAction.MOVE) }
            HomeMenuAction(HomeAction.SELECT) { choose(HomeAction.SELECT) }
            HorizontalDivider()
            HomeMenuAction(HomeAction.DELETE) { choose(HomeAction.DELETE) }
        }
    }
}

@Composable
internal fun HomeActionDialog(action: HomeAction, targets: List<HomeItem>, folders: List<CloudFolder>, source: String?,
    busy: Boolean, error: String?, management: HomeManagement, dismiss: () -> Unit, commit: (name: String, destination: String?) -> Unit) {
    var name by rememberSaveable { mutableStateOf(if (action == HomeAction.RENAME) targets.singleOrNull()?.name.orEmpty() else "") }
    var destination by rememberSaveable { mutableStateOf<String?>(null) }
    val excluded = remember(folders, targets) { blockedDestinations(folders, targets) }
    val hasValidName = name.trim().let { it.isNotEmpty() && it != "." && it != ".." && it.none { c -> c == '/' || c == '\u0000' } }
    val confirmEnabled = when (action) {
        HomeAction.DELETE -> targets.isNotEmpty()
        HomeAction.MOVE -> targets.isNotEmpty() && destination != source && destination !in excluded &&
            (destination == null || folders.any { it.id == destination })
        HomeAction.RENAME -> targets.size == 1 && hasValidName && name.trim() != targets.single().name
        else -> hasValidName
    }
    val verb = when (action) {
        HomeAction.FOLDER, HomeAction.TEXT -> R.string.df_home_create
        HomeAction.MOVE -> R.string.df_home_move_here
        else -> action.label
    }
    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text(label(action.label)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (action) {
                    HomeAction.MOVE -> {
                        val here = folders.find { it.id == destination }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (here != null) IconButton(onClick = { destination = here.parentId }, enabled = !busy,
                                modifier = Modifier.testTag("home-destination-up")) {
                                Icon(Icons.AutoMirrored.Outlined.ArrowBack, label(R.string.df_back))
                            }
                            Text(remoteLabel(destination, folders), style = MaterialTheme.typography.titleSmall,
                                maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        val children = remember(folders, destination, excluded) {
                            folders.filter { it.parentId == destination && it.id !in excluded }.sortedBy { it.name.lowercase() }
                        }
                        if (children.isEmpty()) Text(label(R.string.df_no_subfolders), style = MaterialTheme.typography.bodySmall)
                        else LazyColumn(Modifier.heightIn(max = 250.dp)) {
                            items(children, key = { it.id }) { folder ->
                                ListItem(headlineContent = { Text(folder.name) },
                                    leadingContent = { Icon(painterResource(R.drawable.df_folder), null) },
                                    modifier = Modifier.testTag("home-destination-" + folder.id)
                                        .clickable(enabled = !busy) { destination = folder.id })
                            }
                        }
                    }
                    HomeAction.DELETE -> {
                        Text(if (targets.size == 1) label(R.string.df_home_delete_one, targets.first().name)
                             else label(R.string.df_home_delete_many, targets.size))
                        if (targets.any { it.isFolder }) Text(label(R.string.df_home_delete_tree),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    else -> Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().testTag("home-name"),
                            singleLine = true, enabled = !busy, label = { Text(label(R.string.df_home_name)) },
                            isError = name.isNotEmpty() && !hasValidName)
                        if (action == HomeAction.TEXT) OutlinedTextField(management.newTextBody, { management.newTextBody = it },
                            Modifier.fillMaxWidth().testTag("home-content"), enabled = !busy, minLines = 3, maxLines = 6,
                            label = { Text(label(R.string.df_home_content)) })
                    }
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && confirmEnabled, modifier = Modifier.testTag("home-confirm"),
                onClick = { commit(name.trim(), destination) }) {
                Text(label(verb), color = if (action == HomeAction.DELETE) MaterialTheme.colorScheme.error else LocalContentColor.current)
            }
        }, dismissButton = {
            TextButton(onClick = dismiss, enabled = !busy, modifier = Modifier.testTag("home-cancel")) { Text(label(R.string.df_cancel)) }
        })
}

/** A moved folder and all of its descendants are ineligible destinations. */
internal fun blockedDestinations(folders: List<CloudFolder>, selected: List<HomeItem>): Set<String> {
    val excluded = mutableSetOf<String>()
    val queue = ArrayDeque(selected.filter { it.isFolder }.map { it.id })
    val children = folders.groupBy { it.parentId }
    while (queue.isNotEmpty()) {
        val id = queue.removeFirst()
        if (excluded.add(id)) children[id]?.forEach { queue.add(it.id) }
    }
    return excluded
}
