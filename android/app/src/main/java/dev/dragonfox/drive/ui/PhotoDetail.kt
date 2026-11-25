package dev.dragonfox.drive.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.LoadedPhoto
import dev.dragonfox.drive.gallery.PhotoExif
import dev.dragonfox.drive.protocol.CloudFile
import java.text.NumberFormat
import kotlin.math.abs
import kotlin.math.roundToLong
import kotlinx.coroutines.CancellationException

@Composable
internal fun PhotoDetail(file: CloudFile, load: suspend (CloudFile, Boolean) -> LoadedPhoto,
    navigation: MediaNavigation? = null, onBack: () -> Unit) {
    PhotoDetail(file.id, file.revision, file.name, { load(file, true) }, navigation, onBack)
}

@Composable
internal fun PhotoDetail(id: String, revision: String, name: String, load: suspend () -> LoadedPhoto,
    navigation: MediaNavigation?, onBack: () -> Unit) {
    val context = LocalContext.current
    var result by remember(id, revision) { mutableStateOf<LoadedPhoto?>(null) }
    var error by remember(id, revision) { mutableStateOf<String?>(null) }
    var attempt by remember(id) { mutableIntStateOf(0) }
    var scale by rememberSaveable(id, revision) { mutableFloatStateOf(1f) }
    var pan by remember(id, revision) { mutableStateOf(Offset.Zero) }
    val callbacks by rememberUpdatedState(navigation)
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    val bitmap = result?.bitmap
    val opacity by animateFloatAsState(if (bitmap != null) 1f else 0f, tween(160), label = "photo-arrival")
    fun transform(zoom: Float, pivot: Offset, translation: Offset) {
        if (bitmap == null || !pivot.isSpecified || viewport.width == 0 || viewport.height == 0) return
        val old = scale
        val next = (old * zoom).coerceIn(1f, 6f)
        val focus = pivot - Offset(viewport.width / 2f, viewport.height / 2f)
        val shifted = focus + (pan - focus) * (next / old) + translation
        pan = clampPhotoPan(viewport, IntSize(bitmap.width, bitmap.height), next, shifted)
        scale = next
    }
    LaunchedEffect(id, revision, attempt) {
        error = null
        try { result = load() }
        catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.localizedMessage ?: context.getString(R.string.df_request_failed)
        }
    }
    MediaViewer(name, navigation, R.string.df_camera_info, onBack,
        information = {
            val data = result?.exif
            if (data != null) {
                val rows = data.rows()
                if (rows.isEmpty()) Text(label(R.string.df_no_exif))
                rows.forEach { (id, value) -> MediaInfoRow(label(id), value) }
            } else if (error != null) Text(label(R.string.df_no_exif))
            else LinearProgressIndicator(Modifier.fillMaxWidth())
        },
        action = {
            if (bitmap != null) {
                val reset = scale > 1.01f
                val zoomLabel = label(if (reset) R.string.df_fit_photo else R.string.df_enlarge_photo)
                IconButton(onClick = {
                    transform(if (reset) 1f / scale else 2f, Offset(viewport.width / 2f, viewport.height / 2f), Offset.Zero)
                }) {
                    Icon(androidx.compose.ui.res.painterResource(if (reset) R.drawable.df_fit_photo else R.drawable.df_zoom_photo),
                        zoomLabel, tint = Color.White)
                }
            }
        }) { toggle ->
        when {
            bitmap != null -> {
                val onToggle by rememberUpdatedState(toggle)
                val toggleLabel = label(R.string.df_toggle_viewer_tools)
                Box(Modifier.fillMaxSize().clipToBounds().onSizeChanged { viewport = it }
                    .pointerInput(id, bitmap) {
                        detectTapGestures(onTap = { onToggle() }, onDoubleTap = {
                            transform(if (scale > 1.01f) 1f / scale else 2f, it, Offset.Zero)
                        })
                    }.pointerInput(id, bitmap) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            var travelled = Offset.Zero
                            var transformed = scale > 1.01f
                            do {
                                val event = awaitPointerEvent()
                                val zoom = event.calculateZoom()
                                val drag = event.calculatePan()
                                travelled += drag
                                if (event.changes.count { it.pressed } > 1) transformed = true
                                if (event.changes.any { it.pressed } && (transformed || travelled.getDistance() > viewConfiguration.touchSlop)) {
                                    if (transformed) transform(zoom, event.calculateCentroid(useCurrent = false), drag)
                                    event.changes.forEach { it.consume() }
                                }
                            } while (event.changes.any { it.pressed })
                            if (!transformed && abs(travelled.x) >= 54.dp.toPx() && abs(travelled.x) > abs(travelled.y) * 1.5f) {
                                if (travelled.x < 0) callbacks?.onNext?.invoke() else callbacks?.onPrevious?.invoke()
                            }
                        }
                    }.semantics { onClick(label = toggleLabel) { onToggle(); true } }) {
                    Image(bitmap.asImageBitmap(), name, Modifier.fillMaxSize().graphicsLayer {
                        scaleX = scale; scaleY = scale; translationX = pan.x; translationY = pan.y; alpha = opacity
                    }, contentScale = ContentScale.Fit)
                }
            }
            error != null -> Column(Modifier.align(Alignment.Center).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(error.orEmpty(), color = Color.White)
                FilledTonalButton(onClick = { attempt++ }) { Text(label(R.string.df_retry)) }
            }
            result != null -> Text(label(R.string.df_no_preview), Modifier.align(Alignment.Center), color = Color.White)
            else -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
        }
    }
}

/** Bound panning by the fitted bitmap. Letterboxed areas have no scroll range. */
internal fun clampPhotoPan(viewport: IntSize, image: IntSize, scale: Float, shift: Offset): Offset {
    val fit = minOf(viewport.width.toFloat() / image.width, viewport.height.toFloat() / image.height)
    val extentX = ((image.width * fit * scale - viewport.width) / 2f).coerceAtLeast(0f)
    val extentY = ((image.height * fit * scale - viewport.height) / 2f).coerceAtLeast(0f)
    return Offset(
        if (extentX == 0f) 0f else shift.x.coerceIn(-extentX, extentX),
        if (extentY == 0f) 0f else shift.y.coerceIn(-extentY, extentY),
    )
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
