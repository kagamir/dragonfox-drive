package dev.dragonfox.drive.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.LoadedPhoto
import dev.dragonfox.drive.gallery.PhotoExif
import dev.dragonfox.drive.protocol.CloudFile
import java.text.NumberFormat
import kotlin.math.roundToLong
import kotlinx.coroutines.CancellationException

@Composable
internal fun PhotoDetail(file: CloudFile, load: suspend (CloudFile, Boolean) -> LoadedPhoto, onBack: () -> Unit) {
    PhotoDetail(file.id, file.revision, file.name, { load(file, true) }, onBack)
}

@Composable
internal fun PhotoDetail(id: String, revision: String, name: String, load: suspend () -> LoadedPhoto, onBack: () -> Unit) {
    val context = LocalContext.current
    var result by remember(id, revision) { mutableStateOf<LoadedPhoto?>(null) }
    var error by remember(id, revision) { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var expanded by rememberSaveable(id) { mutableStateOf(false) }
    LaunchedEffect(id, revision, attempt) {
        error = null
        try { result = load() }
        catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        }
    }
    BackHandler(expanded) { expanded = false }
    Column(Modifier.fillMaxSize()) {
        Header(name, onBack) {
            IconToggleButton(checked = expanded, onCheckedChange = { expanded = it }) {
                Icon(Icons.Outlined.Info, label(R.string.df_camera_info))
            }
        }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val maxPanel = maxHeight * 0.48f
            Column {
                Box(Modifier.weight(1f).fillMaxWidth().background(Color(0xff101114)).clipToBounds(),
                    contentAlignment = Alignment.Center) {
                    val bitmap = result?.bitmap
                    when {
                        bitmap != null -> {
                            var scale by remember(id) { mutableFloatStateOf(1f) }
                            var pan by remember(id) { mutableStateOf(Offset.Zero) }
                            Image(bitmap.asImageBitmap(), name, Modifier.fillMaxSize()
                                .pointerInput(id) {
                                    detectTapGestures(onDoubleTap = {
                                        scale = if (scale > 1f) 1f else 2f
                                        pan = Offset.Zero
                                    })
                                }
                                .pointerInput(id) {
                                    detectTransformGestures { _, drag, zoom, _ ->
                                        scale = (scale * zoom).coerceIn(1f, 6f)
                                        val limitX = size.width * (scale - 1f) / 2
                                        val limitY = size.height * (scale - 1f) / 2
                                        pan = Offset((pan.x + drag.x).coerceIn(-limitX, limitX),
                                            (pan.y + drag.y).coerceIn(-limitY, limitY))
                                    }
                                }.graphicsLayer {
                                    scaleX = scale; scaleY = scale
                                    translationX = pan.x; translationY = pan.y
                                }, contentScale = ContentScale.Fit)
                        }
                        error != null -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(16.dp)) {
                            Text(error.orEmpty(), color = Color.White)
                            FilledTonalButton(onClick = { attempt++ }) { Text(label(R.string.df_retry)) }
                        }
                        result != null -> Text(label(R.string.df_no_preview), color = Color.White)
                        else -> CircularProgressIndicator(color = Color.White)
                    }
                }
                AnimatedVisibility(visible = expanded) {
                    Column(Modifier.heightIn(max = maxPanel).fillMaxWidth().verticalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(label(R.string.df_camera_info), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        val data = result?.exif
                        when {
                            data != null -> {
                                val fields = data.rows()
                                if (fields.isEmpty()) Text(label(R.string.df_no_exif), style = MaterialTheme.typography.bodyMedium)
                                fields.forEach { (id, value) ->
                                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                        Text(label(id), Modifier.weight(0.42f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        Text(value, Modifier.weight(0.58f))
                                    }
                                }
                            }
                            error != null -> Text(label(R.string.df_no_exif))
                            else -> LinearProgressIndicator(Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
    }
}

internal fun PhotoExif.rows(): List<Pair<Int, String>> = buildList {
    fun text(id: Int, value: String?) { if (!value.isNullOrBlank()) add(id to value) }
    val decimal = NumberFormat.getNumberInstance().apply { maximumFractionDigits = 2; isGroupingUsed = false }
    text(R.string.df_camera_make, make)
    text(R.string.df_camera_model, model)
    text(R.string.df_camera_lens, lens)
    text(R.string.df_camera_date, dateTime)
    aperture?.takeIf { it.isFinite() && it > 0 }?.let { text(R.string.df_camera_aperture, "ƒ/" + decimal.format(it)) }
    exposureSeconds?.takeIf { it.isFinite() && it > 0 }?.let {
        val reciprocal = (1.0 / it).roundToLong()
        val value = if (it < .5 && reciprocal > 0 && kotlin.math.abs(reciprocal * it - 1) < .03) "1/$reciprocal" else decimal.format(it)
        text(R.string.df_camera_shutter, "$value s")
    }
    iso?.takeIf { it > 0 }?.let { text(R.string.df_camera_iso, it.toString()) }
    focalLengthMm?.takeIf { it.isFinite() && it > 0 }?.let { text(R.string.df_camera_focal, decimal.format(it) + " mm") }
    if (width != null && height != null && width > 0 && height > 0) text(R.string.df_camera_dimensions, "$width × $height")
    if (latitude != null && longitude != null && latitude in -90.0..90.0 && longitude in -180.0..180.0) {
        decimal.maximumFractionDigits = 5
        text(R.string.df_camera_location, decimal.format(latitude) + "°, " + decimal.format(longitude) + "°")
    }
}
