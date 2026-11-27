package dev.dragonfox.drive.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.dragonfox.drive.R

@Composable
internal fun TransferNotificationPermission() {
    if (Build.VERSION.SDK_INT < 33) return
    val activity = LocalActivity.current ?: return
    val permission = Manifest.permission.POST_NOTIFICATIONS
    fun granted() = activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    var allowed by remember { mutableStateOf(granted()) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { allowed = granted() }
    if (allowed) return
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    val prefs = remember { activity.getSharedPreferences("transfer-notifications", 0) }
    TextButton(onClick = {
        if (prefs.getBoolean("requested", false) && !activity.shouldShowRequestPermissionRationale(permission)) {
            activity.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName))
        } else {
            prefs.edit().putBoolean("requested", true).apply()
            launcher.launch(permission)
        }
    }) { Text(stringResource(R.string.df_transfer_enable_notifications)) }
}
