package dev.dragonfox.drive.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R

internal data class MediaNavigation(
    val index: Int,
    val total: Int,
    val onPrevious: (() -> Unit)?,
    val onNext: (() -> Unit)?,
)

@Composable
internal fun MediaViewer(name: String, navigation: MediaNavigation?, infoLabel: Int, onBack: () -> Unit,
    information: @Composable ColumnScope.() -> Unit, playback: (@Composable () -> Unit)? = null,
    action: (@Composable () -> Unit)? = null, content: @Composable BoxScope.(toggleTools: () -> Unit) -> Unit) {
    var tools by rememberSaveable { mutableStateOf(true) }
    var info by rememberSaveable { mutableStateOf(false) }
    BackHandler(info) { info = false }
    val top = Brush.verticalGradient(listOf(Color.Black.copy(alpha = .87f), Color.Black.copy(alpha = .57f), Color.Transparent))
    val bottom = Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = .72f), Color.Black.copy(alpha = .86f)))
    CompositionLocalProvider(LocalContentColor provides Color.White) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Color(0xff0b0c0e))) {
            val panelHeight = maxHeight * .54f
            content {
                if (info) info = false else tools = !tools
            }
            AnimatedVisibility(visible = tools || info, modifier = Modifier.align(Alignment.TopCenter),
                enter = fadeIn(), exit = fadeOut()) {
                Row(Modifier.fillMaxWidth().background(top).padding(start = 4.dp, end = 4.dp, top = 2.dp, bottom = 14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, label(R.string.df_back)) }
                    Text(name, Modifier.weight(1f).semantics { heading() }.testTag("viewer-title"),
                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    action?.invoke()
                    IconToggleButton(checked = info, onCheckedChange = { info = it }, modifier = Modifier.testTag("viewer-info")) {
                        Icon(Icons.Outlined.Info, label(infoLabel), tint = if (info) Color(0xffffb38a) else Color.White)
                    }
                }
            }
            if (info) {
                Surface(modifier = Modifier.align(Alignment.BottomCenter).widthIn(max = 700.dp).fillMaxWidth()
                    .heightIn(max = panelHeight), shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
                    color = Color(0xff202227), contentColor = Color.White) {
                    Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(label(infoLabel), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(name, color = Color.LightGray, style = MaterialTheme.typography.bodySmall)
                        information()
                    }
                }
            } else if (navigation != null || playback != null) {
                AnimatedVisibility(visible = tools, modifier = Modifier.align(Alignment.BottomCenter),
                    enter = fadeIn(), exit = fadeOut()) {
                    Column(Modifier.fillMaxWidth().background(bottom).padding(horizontal = 12.dp, vertical = 4.dp),
                        horizontalAlignment = Alignment.CenterHorizontally) {
                        playback?.invoke()
                        if (navigation != null) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconButton(onClick = { navigation.onPrevious?.invoke() }, enabled = navigation.onPrevious != null,
                                    modifier = Modifier.testTag("viewer-previous")) {
                                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, label(R.string.df_previous_media),
                                        tint = Color.White.copy(alpha = if (navigation.onPrevious != null) 1f else .35f))
                                }
                                Text(label(R.string.df_media_position, navigation.index + 1, navigation.total),
                                    Modifier.padding(horizontal = 8.dp).testTag("viewer-position"),
                                    style = MaterialTheme.typography.labelLarge)
                                IconButton(onClick = { navigation.onNext?.invoke() }, enabled = navigation.onNext != null,
                                    modifier = Modifier.testTag("viewer-next")) {
                                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, label(R.string.df_next_media),
                                        tint = Color.White.copy(alpha = if (navigation.onNext != null) 1f else .35f))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun MediaInfoRow(title: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, Modifier.weight(.42f), color = Color.LightGray, style = MaterialTheme.typography.bodyMedium)
        Text(value, Modifier.weight(.58f), style = MaterialTheme.typography.bodyMedium)
    }
}
