package dev.dragonfox.drive.ui

import android.net.Uri
import android.text.format.Formatter
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.VideoView
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.LocalMediaLoader
import dev.dragonfox.drive.gallery.isLocalVideo
import java.io.File
import java.util.Locale
import kotlin.math.abs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

@Composable
internal fun LocalMediaDetail(file: File, navigation: MediaNavigation? = null, onBack: () -> Unit) {
    Box(Modifier.fillMaxSize().testTag("local-media-detail")) {
        key(file.path) {
            if (isLocalVideo(file)) LocalPlayback(file, navigation, onBack = onBack)
            else PhotoDetail(file.path, "", file.name, { LocalMediaLoader.photo(file) }, navigation, onBack)
        }
    }
}

@Composable
internal fun LocalPlayback(file: File, navigation: MediaNavigation? = null, audioOnly: Boolean = false, onBack: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val bytes by produceState<Long?>(null, file) { value = withContext(Dispatchers.IO) { file.length() } }
    var failed by remember { mutableStateOf(false) }
    var position by rememberSaveable { mutableIntStateOf(0) }
    var wantsPlay by rememberSaveable { mutableStateOf(!audioOnly) }
    var attempt by remember { mutableIntStateOf(0) }
    var ready by remember(attempt) { mutableStateOf(false) }
    var duration by remember(attempt) { mutableIntStateOf(0) }
    var width by remember(attempt) { mutableIntStateOf(0) }
    var height by remember(attempt) { mutableIntStateOf(0) }
    var seeking by remember { mutableStateOf<Float?>(null) }
    val player = remember(attempt) { VideoView(context) }
    val latestNavigation by rememberUpdatedState(navigation)

    // Playback intent is separate from the lifecycle pause. Polling also snapshots
    // the seek position into the saved instance state while the movie is running.
    DisposableEffect(player, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> if (ready) {
                    position = player.currentPosition.coerceAtLeast(0)
                    player.pause()
                }
                Lifecycle.Event.ON_RESUME -> if (ready && wantsPlay && !failed) player.start()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            player.setOnPreparedListener(null)
            player.setOnErrorListener(null)
            player.setOnCompletionListener(null)
            player.stopPlayback()
        }
    }
    LaunchedEffect(ready, wantsPlay, failed) {
        if (ready && wantsPlay && !failed) {
            while (true) {
                if (player.isPlaying) position = player.currentPosition.coerceAtLeast(0)
                delay(350)
            }
        }
    }

    MediaViewer(file.name, navigation, if (audioOnly) R.string.df_audio_information else R.string.df_video_information, onBack,
        information = {
            if (duration > 0) MediaInfoRow(label(R.string.df_video_duration), playbackTime(duration))
            if (width > 0 && height > 0) MediaInfoRow(label(R.string.df_camera_dimensions), "$width × $height")
            bytes?.let { MediaInfoRow(label(R.string.df_media_size), Formatter.formatShortFileSize(context, it)) }
        },
        playback = {
            if (!failed) {
                Row(Modifier.widthIn(max = 680.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = {
                        wantsPlay = !wantsPlay
                        if (wantsPlay) {
                            if (position >= duration) { player.seekTo(0); position = 0 }
                            player.start()
                        } else { player.pause(); position = player.currentPosition.coerceAtLeast(0) }
                    }, enabled = ready, modifier = Modifier.testTag("viewer-play-toggle")) {
                        if (wantsPlay) Icon(painterResource(R.drawable.df_pause_video), label(if (audioOnly) R.string.df_pause_audio else R.string.df_pause_video), tint = Color.White)
                        else Icon(Icons.Default.PlayArrow, label(if (audioOnly) R.string.df_play_audio else R.string.df_play_video), tint = Color.White)
                    }
                    Text(playbackTime(seeking?.toInt() ?: position), style = MaterialTheme.typography.labelMedium)
                    val seekLabel = label(R.string.df_seek_video)
                    Slider(value = (seeking ?: position.toFloat()).coerceIn(0f, duration.coerceAtLeast(1).toFloat()),
                        onValueChange = { seeking = it }, valueRange = 0f..duration.coerceAtLeast(1).toFloat(),
                        enabled = ready && duration > 0,
                        onValueChangeFinished = {
                            seeking?.let { position = it.toInt(); player.seekTo(position) }
                            seeking = null
                        },
                        modifier = Modifier.weight(1f).padding(horizontal = 6.dp).testTag("viewer-seek")
                            .semantics { contentDescription = seekLabel },
                        colors = SliderDefaults.colors(thumbColor = Color.White, activeTrackColor = Color.White,
                            inactiveTrackColor = Color.Gray))
                    Text(playbackTime(duration), style = MaterialTheme.typography.labelMedium)
                }
            }
        }) { toggle ->
        if (failed) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(label(if (audioOnly) R.string.df_audio_failed else R.string.df_local_video_failed), color = Color.White)
                FilledTonalButton(onClick = { failed = false; attempt++ }) { Text(label(R.string.df_retry)) }
            }
        } else {
            key(attempt) {
                AndroidView(modifier = Modifier.fillMaxSize(), factory = {
                    FrameLayout(context).apply {
                        addView(player, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
                        player.setOnErrorListener { _, _, _ -> failed = true; ready = false; true }
                        player.setOnCompletionListener { wantsPlay = false; position = duration }
                        player.setOnPreparedListener { media ->
                            duration = media.duration.coerceAtLeast(0)
                            width = media.videoWidth
                            height = media.videoHeight
                            ready = true
                            if (position > 0) player.seekTo(position)
                            if (wantsPlay && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) player.start()
                        }
                        player.setVideoURI(Uri.fromFile(file))
                    }
                })
            }
            if (audioOnly) {
                Surface(Modifier.align(Alignment.Center).size(112.dp).testTag("file-audio"),
                    shape = MaterialTheme.shapes.extraLarge, color = Color(0xff332a27)) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(painterResource(R.drawable.df_audio_note), null,
                            Modifier.size(50.dp), tint = Color(0xffffb38a))
                    }
                }
            }
            if (!ready) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            Box(Modifier.fillMaxSize().semantics { contentDescription = file.name }
                .clickable(onClickLabel = label(R.string.df_toggle_viewer_tools)) { toggle() }
                .pointerInput(file) {
                    var distance = 0f
                    detectHorizontalDragGestures(onDragStart = { distance = 0f }, onDragEnd = {
                        if (abs(distance) >= 54.dp.toPx()) {
                            if (distance < 0f) latestNavigation?.onNext?.invoke() else latestNavigation?.onPrevious?.invoke()
                        }
                    }) { change, amount -> distance += amount; change.consume() }
                })
        }
    }
}

internal fun playbackTime(milliseconds: Int): String {
    val seconds = milliseconds.coerceAtLeast(0) / 1000
    return if (seconds < 3600) "%d:%02d".format(Locale.ROOT, seconds / 60, seconds % 60)
    else "%d:%02d:%02d".format(Locale.ROOT, seconds / 3600, seconds / 60 % 60, seconds % 60)
}
