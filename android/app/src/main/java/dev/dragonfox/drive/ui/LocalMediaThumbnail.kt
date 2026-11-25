package dev.dragonfox.drive.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.R
import dev.dragonfox.drive.gallery.LocalMediaLoader
import kotlinx.coroutines.CancellationException
import java.io.File

@Composable
internal fun LocalMediaThumbnail(file: File, modifier: Modifier = Modifier) {
    var preview by remember(file) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(file) {
        preview = try {
            LocalMediaLoader.thumbnail(file)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceContainerHighest), contentAlignment = Alignment.Center) {
        val image = preview
        if (image != null) {
            Image(image.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            Icon(painterResource(R.drawable.df_local_media), null, Modifier.size(28.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
