package dev.dragonfox.drive.ui

import android.text.format.Formatter
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.protocol.CloudFolder
import dev.dragonfox.drive.sync.FolderScanner
import dev.dragonfox.drive.sync.storageDepth
import dev.dragonfox.drive.sync.SyncConfig
import dev.dragonfox.drive.sync.SyncMode
import dev.dragonfox.drive.sync.SyncStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

@Composable
internal fun remoteLabel(id: String?, folders: List<CloudFolder>): String {
    if (id == null) return label(R.string.df_root)
    val byId = remember(folders) { folders.associateBy { it.id } }
    val parts = mutableListOf<String>()
    val seen = mutableSetOf<String>()
    var cursor = byId[id] ?: return label(R.string.df_saved_folder)
    while (seen.add(cursor.id)) {
        parts.add(cursor.name)
        cursor = byId[cursor.parentId] ?: break
    }
    return "/" + parts.asReversed().joinToString("/")
}

@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

@Composable
private fun Section(title: String) {
    Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
}

@Composable
internal fun PermissionPanel(onGrant: () -> Unit) {
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(painterResource(R.drawable.df_folder), null, tint = MaterialTheme.colorScheme.primary)
            Section(label(R.string.df_access_title))
        }
        Text(label(R.string.df_access_body), style = MaterialTheme.typography.bodyMedium)
        OutlinedButton(onClick = onGrant) { Text(label(R.string.df_grant)) }
    }
}

@Composable
internal fun Dashboard(config: SyncConfig, status: SyncStatus, target: String, allowed: Boolean,
    onEdit: () -> Unit, onRefresh: () -> Unit, onPermission: () -> Unit, onEnabled: (Boolean) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val context = LocalContext.current
    val state = when {
        !config.enabled -> R.string.df_paused
        !allowed -> R.string.df_access_title
        !status.online -> R.string.df_offline
        status.scanning -> R.string.df_scanning
        status.tasks.isNotEmpty() -> R.string.df_uploading
        status.errors.isNotEmpty() -> R.string.df_attention
        status.running -> R.string.df_syncing
        else -> R.string.df_monitoring
    }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Header(label(R.string.df_tab_sync))
        LazyColumn(Modifier.widthIn(max = 740.dp).fillMaxWidth(), contentPadding = PaddingValues(start = 16.dp,
            end = 16.dp, top = 8.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Surface(color = colors.primaryContainer, contentColor = colors.onPrimaryContainer,
                    shape = RoundedCornerShape(24.dp)) {
                    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(label(R.string.df_auto_sync), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold)
                            Switch(config.enabled, onEnabled, modifier = Modifier.semantics {
                                contentDescription = context.getString(R.string.df_auto_sync)
                            })
                        }
                        Text(label(state), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                        when {
                            status.total > 0 && config.enabled -> {
                                val progress by animateFloatAsState((status.completed.toFloat()/status.total).coerceIn(0f, 1f), label = "batch")
                                LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                                Text(label(R.string.df_progress_count, status.completed, status.total), style = MaterialTheme.typography.bodySmall)
                            }
                            status.scanning -> LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                            else -> Text(label(if (config.enabled) R.string.df_runs_in_app else R.string.df_pause_hint),
                                style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            if (!allowed) item { PermissionPanel(onPermission) }
            item {
                Panel {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Section(label(R.string.df_plan)) }
                        TextButton(onEdit, Modifier.testTag("sync-edit")) { Text(label(R.string.df_edit)) }
                    }
                    Detail(R.drawable.df_folder, label(R.string.df_local_folders, config.localFolders.size),
                        label(if (config.mode == SyncMode.ALL) R.string.df_all_files else R.string.df_media))
                    Detail(R.drawable.df_cloud, target, label(R.string.df_destination))
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) { Section(label(R.string.df_active_tasks)) }
                    IconButton(onClick = onRefresh, enabled = config.enabled && allowed && status.online && !status.running) {
                        Icon(Icons.Outlined.Refresh, label(R.string.df_rescan))
                    }
                }
                Text(label(R.string.df_concurrent, status.concurrency), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            }
            if (config.enabled) item { TransferNotificationPermission() }
            if (status.tasks.isEmpty()) item {
                Panel { Text(label(R.string.df_no_upload), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant) }
            }
            items(status.tasks, key = { it.path }) { task ->
                Panel {
                    Text(File(task.path).name, maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                    LinearProgressIndicator(progress = { if (task.size == 0L) 0f else (task.sent.toFloat()/task.size).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    Text(label(R.string.df_bytes_uploaded, Formatter.formatShortFileSize(context, task.sent),
                        Formatter.formatShortFileSize(context, task.size)), style = MaterialTheme.typography.bodySmall)
                }
            }
            if (status.errors.isNotEmpty()) item { Section(label(R.string.df_sync_errors)) }
            items(status.errors) { error -> Text(error, color = colors.error, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun Detail(icon: Int, title: String, subtitle: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(icon), null, tint = MaterialTheme.colorScheme.primary)
        Column { Text(title, fontWeight = FontWeight.Medium); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
internal fun SyncEditor(mode: SyncMode, folders: List<String>, maxDepth: Int, target: String, allowed: Boolean, onGrant: () -> Unit,
    onLocal: () -> Unit, onCloud: () -> Unit, onBack: () -> Unit, onSave: () -> Unit) {
    val context = LocalContext.current
    val eligible by produceState<List<String>?>(null, folders, maxDepth, allowed) {
        value = null
        if (allowed) value = withContext(Dispatchers.IO) {
            val roots = FolderScanner(context.applicationContext).roots()
            folders.filter { (storageDepth(File(it), roots) ?: 0) in 1..maxDepth }.sorted()
        }
    }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Header(label(R.string.df_plan), onBack)
        LazyColumn(Modifier.widthIn(max = 740.dp).fillMaxWidth().weight(1f), contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (!allowed) item { PermissionPanel(onGrant) }
            item {
                Panel {
                    Detail(R.drawable.df_folder, label(R.string.df_local_folders, folders.size),
                        label(if (mode == SyncMode.ALL) R.string.df_all_files else R.string.df_media))
                    eligible?.let { paths ->
                        paths.take(3).forEach { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2) }
                        if (paths.size > 3) Text(label(R.string.df_other_folders, paths.size - 3), style = MaterialTheme.typography.bodySmall)
                        if (paths.size < folders.size) Text(label(R.string.df_inactive_sources, folders.size - paths.size),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    OutlinedButton(onClick = onLocal, enabled = allowed, modifier = Modifier.testTag("sync-local")) { Text(label(R.string.df_choose_local)) }
                }
            }
            item { Panel {
                Detail(R.drawable.df_cloud, label(R.string.df_destination), target)
                OutlinedButton(onClick = onCloud) { Text(label(R.string.df_choose_cloud)) }
            } }
            item { Text(label(R.string.df_directory_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Button(onClick = onSave, enabled = folders.isNotEmpty() && allowed, modifier = Modifier.widthIn(max = 740.dp).fillMaxWidth().padding(16.dp)) {
            Text(label(R.string.df_save))
        }
    }
}
