package dev.dragonfox.drive.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import dev.dragonfox.drive.R
import dev.dragonfox.drive.protocol.CloudFile
import dev.dragonfox.drive.protocol.createHomeShare
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.temporal.ChronoUnit

/** Shared links and passwords stay in memory across rotation, scoped to the active account. */
internal class HomeShareDraft {
    private var owner: String? = null
    private var operation = Any()
    var password by mutableStateOf("")
    var days by mutableStateOf("")
    var limit by mutableStateOf("")
    var url by mutableStateOf<String?>(null)
        private set
    var passwordRequired by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    var failed by mutableStateOf(false)
        private set

    fun open(id: String) {
        if (owner != id) {
            clear()
            owner = id
        }
    }

    fun clear() {
        operation = Any()
        owner = null
        password = ""
        days = ""
        limit = ""
        url = null
        busy = false
        failed = false
        passwordRequired = false
    }

    fun submit(model: DriveModel, file: CloudFile) {
        if (busy || owner != file.id) return
        val marker = operation
        val passphrase = password.ifEmpty { null }
        val expiry = days.toIntOrNull()?.let { Instant.now().plus(it.toLong(), ChronoUnit.DAYS) }
        val opens = limit.toIntOrNull()
        busy = true
        failed = false
        model.viewModelScope.launch {
            try {
                val link = model.homeRead { it.createHomeShare(file, passphrase, expiry, opens) }
                if (marker === operation) {
                    passwordRequired = passphrase != null
                    password = ""
                    url = link
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (marker === operation) failed = true
            } finally { if (marker === operation) busy = false }
        }
    }
}

@Composable
internal fun HomeShareDialog(file: CloudFile, model: DriveModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val form = remember(file.id, model) { model.homeShareDraft.apply { open(file.id) } }
    val password = form.password
    val days = form.days
    val limit = form.limit
    val busy = form.busy
    fun close() {
        form.clear()
        onDismiss()
    }
    var copied by remember { mutableStateOf(false) }
    val valid = (password.isEmpty() || password.isNotBlank()) &&
        (days.isEmpty() || (days.toIntOrNull() ?: 0) > 0) && (limit.isEmpty() || (limit.toIntOrNull() ?: 0) > 0)
    val link = form.url
    AlertDialog(onDismissRequest = { if (!busy) close() }, title = { Text(stringResource(R.string.df_link_title)) },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(file.name, style = MaterialTheme.typography.titleSmall)
            if (link == null) {
                OutlinedTextField(password, { form.password = it }, enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("home-share-password"),
                    singleLine = true, label = { Text(stringResource(R.string.df_link_password)) },
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                ShareNumber(days, { form.days = it }, R.string.df_link_days, !busy)
                ShareNumber(limit, { form.limit = it }, R.string.df_link_limit, !busy)
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (form.failed) Text(stringResource(R.string.df_link_create_error), color = MaterialTheme.colorScheme.error)
            } else {
                Text(stringResource(if (form.passwordRequired) R.string.df_link_password_hint else R.string.df_link_private))
                SelectionContainer { Text(link, Modifier.testTag("home-share-link"), style = MaterialTheme.typography.bodySmall) }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(onClick = {
                        val clip = ClipData.newPlainText(file.name, link)
                        clip.description.extras = PersistableBundle().apply {
                            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                        }
                        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
                        copied = true
                    }) { Text(stringResource(if (copied) R.string.df_link_copied else R.string.df_link_copy)) }
                    OutlinedButton(onClick = {
                        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
                        context.startActivity(Intent.createChooser(send, null))
                    }) { Text(stringResource(R.string.df_link_send)) }
                }
            }
        } }, dismissButton = {
            if (link == null) TextButton(onClick = ::close, enabled = !busy) { Text(stringResource(R.string.df_cancel)) }
        }, confirmButton = {
            if (link != null) TextButton(onClick = ::close) { Text(stringResource(R.string.df_close)) }
            else Button(enabled = !busy && valid, modifier = Modifier.testTag("home-share-create"), onClick = { form.submit(model, file) }) { Text(stringResource(R.string.df_link_create)) }
        })
}

@Composable
private fun ShareNumber(value: String, change: (String) -> Unit, label: Int, enabled: Boolean) {
    OutlinedTextField(value, change, enabled = enabled, modifier = Modifier.fillMaxWidth(), singleLine = true,
        label = { Text(stringResource(label)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        isError = value.isNotEmpty() && (value.toIntOrNull() ?: 0) <= 0)
}
