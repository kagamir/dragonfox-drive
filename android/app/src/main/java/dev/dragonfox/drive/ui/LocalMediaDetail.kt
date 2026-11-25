package dev.dragonfox.drive.ui

import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.LocalMediaLoader
import dev.dragonfox.drive.gallery.isLocalVideo
import java.io.File

@Composable
internal fun LocalMediaDetail(file: File, onBack: () -> Unit) {
    Box(Modifier.fillMaxSize().testTag("local-media-detail")) {
        if (isLocalVideo(file)) {
            LocalVideo(file, onBack)
        } else {
            PhotoDetail(file.path, "", file.name, { LocalMediaLoader.photo(file) }, onBack)
        }
    }
}

@Composable
private fun LocalVideo(file: File, onBack: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var failed by remember(file) { mutableStateOf(false) }
    var position by rememberSaveable(file.path) { mutableIntStateOf(0) }
    var resumePlayback by rememberSaveable(file.path) { mutableStateOf(true) }
    var attempt by remember(file) { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        Header(file.name, onBack)
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            if (failed) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.df_local_video_failed), color = Color.White)
                    TextButton(onClick = { failed = false; attempt++ }) { Text(stringResource(R.string.df_retry)) }
                }
            } else key(file, attempt) {
                val player = remember { VideoView(context) }
                AndroidView(modifier = Modifier.fillMaxSize(), factory = {
                    player.apply {
                        contentDescription = file.name
                        setMediaController(MediaController(context))
                        setOnErrorListener { _, _, _ -> failed = true; true }
                        setOnPreparedListener {
                            if (position > 0) seekTo(position)
                            if (resumePlayback && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) start()
                        }
                        setVideoURI(Uri.fromFile(file))
                    }
                })
                DisposableEffect(player, lifecycle) {
                    val observer = LifecycleEventObserver { _, event ->
                        when (event) {
                            Lifecycle.Event.ON_PAUSE -> {
                                position = player.currentPosition
                                resumePlayback = player.isPlaying
                                player.pause()
                            }
                            Lifecycle.Event.ON_RESUME -> if (resumePlayback) player.start()
                            else -> Unit
                        }
                    }
                    lifecycle.addObserver(observer)
                    onDispose {
                        lifecycle.removeObserver(observer)
                        player.setOnErrorListener(null)
                        player.setOnPreparedListener(null)
                        player.stopPlayback()
                    }
                }
            }
        }
    }
}
