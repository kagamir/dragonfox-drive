package dev.dragonfox.drive.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.dragonfox.drive.BuildConfig
import dev.dragonfox.drive.R
import dev.dragonfox.drive.sync.SCAN_DEPTH_RANGE
import dev.dragonfox.drive.sync.SYNC_INTERVAL_RANGE
import dev.dragonfox.drive.sync.SyncConfig

internal enum class ThemeChoice(val title: Int) {
    SYSTEM(R.string.df_theme_system),
    LIGHT(R.string.df_theme_light),
    DARK(R.string.df_theme_dark),
}

private enum class Preference { THEME, INTERVAL, DEPTH, ABOUT, SIGN_OUT }

@Composable
internal fun AccountTab(username: String, server: String, theme: ThemeChoice,
    selectTheme: (ThemeChoice) -> Unit, config: SyncConfig, setInterval: (Int) -> Unit,
    setDepth: (Int) -> Unit, signOut: () -> Unit) {
    val version = BuildConfig.VERSION_NAME
    var dialog by rememberSaveable { mutableStateOf<Preference?>(null) }
    val colors = MaterialTheme.colorScheme
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxSize()) {
        Header(label(R.string.df_account))
        LazyColumn(Modifier.widthIn(max = 740.dp).fillMaxWidth(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Surface(shape = RoundedCornerShape(22.dp), color = colors.primaryContainer, contentColor = colors.onPrimaryContainer) {
                    Row(Modifier.fillMaxWidth().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Surface(shape = CircleShape, color = colors.primary, contentColor = colors.onPrimary) {
                            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                                Text(username.take(1).uppercase(), style = MaterialTheme.typography.titleLarge)
                            }
                        }
                        Column(Modifier.weight(1f)) {
                            Text(username, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                            Text(server, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
            item {
                SettingsGroup {
                    PreferenceRow(R.string.df_theme, label(theme.title), "preference-theme") { dialog = Preference.THEME }
                }
            }
            item {
                SettingsGroup {
                    PreferenceRow(R.string.df_sync_interval, label(R.string.df_seconds, config.intervalSeconds), "preference-interval") {
                        dialog = Preference.INTERVAL
                    }
                    HorizontalDivider(color = colors.outlineVariant)
                    PreferenceRow(R.string.df_media_depth, label(R.string.df_levels, config.maxDepth), "preference-depth") {
                        dialog = Preference.DEPTH
                    }
                }
            }
            item {
                SettingsGroup { PreferenceRow(R.string.df_about, version, "account-about") { dialog = Preference.ABOUT } }
            }
            item {
                OutlinedButton(onClick = { dialog = Preference.SIGN_OUT }, modifier = Modifier.fillMaxWidth().testTag("account-signout"),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.error)) { Text(label(R.string.df_signout)) }
            }
        }
    }
    val close = { dialog = null }
    when (dialog) {
        Preference.THEME -> AlertDialog(onDismissRequest = close, title = { Text(label(R.string.df_theme)) },
            text = { Column {
                ThemeChoice.entries.forEach { choice ->
                    Row(Modifier.fillMaxWidth().selectable(selected = theme == choice, role = Role.RadioButton,
                        onClick = { selectTheme(choice); close() }).padding(vertical = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(theme == choice, onClick = null)
                        Text(label(choice.title))
                    }
                }
            } }, confirmButton = {}, dismissButton = { TextButton(onClick = close) { Text(label(R.string.df_cancel)) } })
        Preference.INTERVAL -> NumberPreference(R.string.df_sync_interval, R.string.df_interval_help, config.intervalSeconds,
            SYNC_INTERVAL_RANGE, listOf(45, 300, 900), R.string.df_seconds, close) { setInterval(it); close() }
        Preference.DEPTH -> NumberPreference(R.string.df_media_depth, R.string.df_depth_help, config.maxDepth,
            SCAN_DEPTH_RANGE, listOf(1, 3, 5), R.string.df_levels, close) { setDepth(it); close() }
        Preference.ABOUT -> AlertDialog(onDismissRequest = close, icon = { FoxMark() },
            title = { Text("DragonFox Drive") }, text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(label(R.string.df_app_version, version), fontWeight = FontWeight.Medium)
                    Text(label(R.string.df_about_android))
                }
            }, confirmButton = { TextButton(onClick = close) { Text(label(R.string.df_close)) } })
        Preference.SIGN_OUT -> AlertDialog(onDismissRequest = close, title = { Text(label(R.string.df_signout)) },
            text = { Text(label(R.string.df_signout_body)) },
            confirmButton = { TextButton(onClick = { close(); signOut() }) { Text(label(R.string.df_signout)) } },
            dismissButton = { TextButton(onClick = close) { Text(label(R.string.df_cancel)) } })
        null -> Unit
    }
}

@Composable
private fun SettingsGroup(rows: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) { Column(content = rows) }
}

@Composable
private fun PreferenceRow(title: Int, value: String, tag: String, open: () -> Unit) {
    ListItem(headlineContent = { Text(label(title)) },
        supportingContent = { Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant) },
        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null) },
        modifier = Modifier.fillMaxWidth().testTag(tag).clickable(role = Role.Button, onClick = open))
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun NumberPreference(title: Int, help: Int, current: Int, range: IntRange, presets: List<Int>,
    unitFormat: Int, dismiss: () -> Unit, save: (Int) -> Unit) {
    var input by rememberSaveable { mutableStateOf(current.toString()) }
    val value = input.toIntOrNull()?.takeIf { it in range }
    AlertDialog(onDismissRequest = dismiss, title = { Text(label(title)) },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(label(help, range.first, range.last), style = MaterialTheme.typography.bodyMedium)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                presets.forEach { n ->
                    val caption = if (unitFormat == R.string.df_seconds && n % 60 == 0)
                        label(R.string.df_minutes, n / 60) else label(unitFormat, n)
                    FilterChip(selected = value == n, onClick = { input = n.toString() },
                        label = { Text(caption, style = MaterialTheme.typography.labelSmall) })
                }
            }
            OutlinedTextField(value = input, onValueChange = { input = it }, label = { Text(label(title)) },
                modifier = Modifier.fillMaxWidth().testTag("preference-value"), singleLine = true,
                isError = value == null, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        } }, dismissButton = { TextButton(onClick = dismiss) { Text(label(R.string.df_cancel)) } },
        confirmButton = { Button(onClick = { value?.let(save) }, enabled = value != null) { Text(label(R.string.df_apply)) } })
}
