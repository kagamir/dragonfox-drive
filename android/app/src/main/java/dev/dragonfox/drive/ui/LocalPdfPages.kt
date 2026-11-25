package dev.dragonfox.drive.ui

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import java.io.File
import java.io.IOException
import kotlin.math.roundToInt
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.withContext

private fun openPdf(file: File): PdfRenderer {
    val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    // PdfRenderer takes ownership only after its constructor succeeds.
    return try { PdfRenderer(fd) } catch (e: Exception) {
        fd.close()
        throw e
    }
}

private fun PdfRenderer.Page.renderFor(viewport: IntSize): Bitmap {
    val scale = minOf(
        viewport.width.toDouble() / width, viewport.height.toDouble() / height,
        sqrt(3_000_000.0 / (width.toDouble() * height)), 4096.0 / maxOf(width, height),
    )
    val bitmap = Bitmap.createBitmap((width * scale).roundToInt().coerceAtLeast(1),
        (height * scale).roundToInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    try {
        bitmap.eraseColor(Color.WHITE)
        render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
    } catch (e: Exception) {
        bitmap.recycle()
        throw e
    }
    return bitmap
}

@Composable
internal fun LocalPdfPages(file: File) {
    var page by rememberSaveable(file.path) { mutableIntStateOf(0) }
    var retry by remember(file) { mutableIntStateOf(0) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    var count by remember(file, retry) { mutableIntStateOf(0) }
    var rendered by remember(file, retry) { mutableStateOf<Pair<Int, Bitmap>?>(null) }
    var failed by remember(file, retry) { mutableStateOf(false) }

    LaunchedEffect(file, retry) {
        try {
            withContext(Dispatchers.IO) {
                openPdf(file).use { pdf ->
                    if (pdf.pageCount < 1) throw IOException("Empty PDF")
                    withContext(Dispatchers.Main.immediate) {
                        count = pdf.pageCount
                        page = page.coerceIn(0, count - 1)
                    }
                    snapshotFlow { page to viewport }.conflate().collect { (index, size) ->
                        if (size.width > 0 && size.height > 0) {
                            ensureActive()
                            val bitmap = pdf.openPage(index).use { it.renderFor(size) }
                            withContext(Dispatchers.Main.immediate) {
                                if (page == index && viewport == size) rendered = index to bitmap
                                else bitmap.recycle()
                            }
                        }
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
        }
    }

    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerLow)
            .onSizeChanged { viewport = it }, contentAlignment = Alignment.Center) {
            val current = rendered?.takeIf { it.first == page }?.second
            when {
                failed -> Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(label(R.string.df_pdf_error))
                    FilledTonalButton(onClick = { retry++ }) { Text(label(R.string.df_retry)) }
                }
                current != null -> Image(remember(current) { current.asImageBitmap() },
                    label(R.string.df_page_count, page + 1, count),
                    Modifier.fillMaxSize().testTag("file-pdf-page"), contentScale = ContentScale.Fit)
                else -> CircularProgressIndicator()
            }
        }
        if (!failed && count > 0) {
            HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { page-- }, enabled = page > 0, modifier = Modifier.testTag("file-pdf-previous")) {
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, label(R.string.df_pdf_previous))
                }
                Text(label(R.string.df_page_count, page + 1, count), Modifier.padding(horizontal = 12.dp),
                    style = MaterialTheme.typography.labelLarge)
                IconButton(onClick = { page++ }, enabled = page + 1 < count, modifier = Modifier.testTag("file-pdf-next")) {
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, label(R.string.df_pdf_next))
                }
            }
        }
    }
}
