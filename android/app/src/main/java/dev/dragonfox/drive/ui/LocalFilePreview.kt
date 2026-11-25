package dev.dragonfox.drive.ui

import android.text.format.Formatter
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun LocalFilePreview(file: File, mime: String, onBack: () -> Unit) {
    key(file.path, mime) {
        val kind = remember(file, mime) { previewKind(file, mime) }
        when (kind) {
            PreviewKind.IMAGE, PreviewKind.VIDEO -> LocalMediaDetail(file, onBack = onBack)
            PreviewKind.AUDIO -> LocalPlayback(file, audioOnly = true, onBack = onBack)
            else -> DocumentPreview(file, mime, kind, onBack)
        }
    }
}

@Composable
private fun DocumentPreview(file: File, mime: String, kind: PreviewKind, onBack: () -> Unit) {
    val subtitle = when (kind) {
        PreviewKind.PDF -> R.string.df_pdf_preview
        PreviewKind.TEXT -> R.string.df_text_preview
        else -> R.string.df_file_details
    }
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, label(R.string.df_back)) }
                Column(Modifier.weight(1f).padding(end = 16.dp)) {
                    Text(label(subtitle), style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary)
                    Text(file.name, Modifier.semantics { heading() }.testTag("viewer-title"),
                        style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            HorizontalDivider()
            when (kind) {
                PreviewKind.PDF -> LocalPdfPages(file)
                PreviewKind.TEXT -> LocalText(file)
                else -> UnsupportedFile(file, mime)
            }
        }
    }
}

@Composable
private fun LocalText(file: File) {
    var retry by remember { mutableIntStateOf(0) }
    var ready by remember(retry) { mutableStateOf(false) }
    var failed by remember(retry) { mutableStateOf(false) }
    var excerpt by remember(retry) { mutableStateOf<TextExcerpt?>(null) }
    LaunchedEffect(file, retry) {
        try {
            excerpt = withContext(Dispatchers.IO) { readTextExcerpt(file) }
        } catch (_: IOException) {
            failed = true
        } catch (_: SecurityException) {
            failed = true
        }
        ready = true
    }
    val content = excerpt
    when {
        !ready -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        failed -> Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(label(R.string.df_local_read_error))
            FilledTonalButton(onClick = { retry++ }) { Text(label(R.string.df_retry)) }
        }
        content == null -> Text(label(R.string.df_text_encoding), Modifier.padding(24.dp))
        content.rows.isEmpty() -> Text(label(R.string.df_empty_text), Modifier.padding(24.dp))
        else -> Column(Modifier.fillMaxSize()) {
            if (content.truncated) {
                Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
                    Text(label(R.string.df_text_truncated), Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.labelMedium)
                }
            }
            SelectionContainer {
                LazyColumn(Modifier.fillMaxSize().testTag("file-text-content"), contentPadding = PaddingValues(20.dp)) {
                    items(content.rows) { row ->
                        Text(row, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun UnsupportedFile(file: File, mime: String) {
    val context = LocalContext.current
    val size by produceState<Long?>(null, file) {
        value = withContext(Dispatchers.IO) {
            try {
                if (Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) file.length() else null
            } catch (_: SecurityException) { null }
        }
    }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp).testTag("file-preview-unsupported"),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label(R.string.df_no_file_preview), style = MaterialTheme.typography.bodyLarge)
        HorizontalDivider()
        SelectionContainer { Text(file.name, style = MaterialTheme.typography.titleMedium) }
        Text(label(R.string.df_file_type), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(mime.ifBlank { "application/octet-stream" })
        size?.let {
            Text(label(R.string.df_media_size), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(Formatter.formatShortFileSize(context, it))
        }
    }
}
