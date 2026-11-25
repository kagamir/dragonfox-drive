package dev.dragonfox.drive.ui

import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource as label
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dragonfox.drive.R
import dev.dragonfox.drive.sync.FileAccess
import dev.dragonfox.drive.sync.SyncEngine
import dev.dragonfox.drive.sync.SyncMode
import kotlinx.coroutines.launch

private val lightPalette = lightColorScheme(
    primary = Color(0xFFA84621), onPrimary = Color.White,
    primaryContainer = Color(0xFFFFE7D8), onPrimaryContainer = Color(0xFF702A11),
    secondary = Color(0xFF745847), secondaryContainer = Color(0xFFF3E5D9),
    background = Color(0xFFF8F7F3), surface = Color(0xFFFFFEFB),
    onSurface = Color(0xFF302C27), onBackground = Color(0xFF302C27),
    onSurfaceVariant = Color(0xFF645E56), outlineVariant = Color(0xFFE0DCD5)
)
private val darkPalette = darkColorScheme(
    primary = Color(0xFFF2A67D), onPrimary = Color(0xFF42200F),
    primaryContainer = Color(0xFF4C2D22), onPrimaryContainer = Color(0xFFFFDCC9),
    secondary = Color(0xFFE3C3AD), secondaryContainer = Color(0xFF443B35),
    background = Color(0xFF101216), surface = Color(0xFF1A1D23),
    onSurface = Color(0xFFEDE9E4), onBackground = Color(0xFFEDE9E4),
    onSurfaceVariant = Color(0xFFC5BDB5), outlineVariant = Color(0xFF41434A)
)

@Composable
internal fun DriveApp(model: DriveModel, onDarkModeChanged: (Boolean) -> Unit = {}) {
    val dark = when (model.theme) {
        ThemeChoice.SYSTEM -> isSystemInDarkTheme()
        ThemeChoice.LIGHT -> false
        ThemeChoice.DARK -> true
    }
    LaunchedEffect(dark) { onDarkModeChanged(dark) }
    MaterialTheme(colorScheme = if (dark) darkPalette else lightPalette) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            val engine = model.engine
            when {
                model.restoring -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                engine == null -> Login(model)
                else -> key(model.account?.server, model.account?.userId) { SignedInApp(model, engine) }
            }
        }
    }
}

private enum class DriveTab(val title: Int, val tag: String) {
    HOME(R.string.df_tab_home, "tab-home"),
    SYNC(R.string.df_tab_sync, "tab-sync"),
    ACCOUNT(R.string.df_account, "tab-account")
}

@Composable
private fun SignedInApp(model: DriveModel, engine: SyncEngine) {
    var tab by rememberSaveable { mutableStateOf(DriveTab.HOME) }
    val holder = rememberSaveableStateHolder()
    val config by engine.config.collectAsStateWithLifecycle()
    BackHandler(tab != DriveTab.HOME) { tab = DriveTab.HOME }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar {
                DriveTab.entries.forEach { entry ->
                    NavigationBarItem(selected = tab == entry, onClick = { tab = entry },
                        icon = {
                            when (entry) {
                                DriveTab.HOME -> Icon(Icons.Outlined.Home, null)
                                DriveTab.SYNC -> Icon(painterResource(R.drawable.df_sync), null)
                                DriveTab.ACCOUNT -> Icon(Icons.Outlined.AccountCircle, null)
                            }
                        },
                        label = { Text(label(entry.title)) },
                        modifier = Modifier.testTag(entry.tag))
                }
            }
        },
    ) { insets ->
        Box(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
            holder.SaveableStateProvider(tab.name) {
                when (tab) {
                    DriveTab.HOME -> model.photoLoader?.let { loader ->
                        CloudBrowser(model.cloudFolders, model.cloudFiles, model::refreshDrive, model::setFolderType,
                            loader::load)
                    }
                    DriveTab.SYNC -> SyncTab(model, engine)
                    DriveTab.ACCOUNT -> AccountTab(
                        username = model.account?.username.orEmpty(), server = model.account?.server.orEmpty(),
                        theme = model.theme, selectTheme = model::selectTheme, config = config,
                        setInterval = { engine.configure(engine.config.value.copy(intervalSeconds = it)) },
                        setDepth = { engine.configure(engine.config.value.copy(maxDepth = it)) },
                        signOut = { model.signOut() })
                }
            }
        }
    }
}

@Composable
private fun SyncTab(model: DriveModel, engine: SyncEngine) {
    val config by engine.config.collectAsStateWithLifecycle()
    val status by engine.status.collectAsStateWithLifecycle()
    val context = androidx.compose.ui.platform.LocalContext.current
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    var allowed by remember { mutableStateOf(FileAccess.granted(context)) }
    DisposableEffect(lifecycle, context) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) allowed = FileAccess.granted(context)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(engine, config.remoteFolderId) {
        if (config.remoteFolderId != null && model.cloudFolders.none { it.id == config.remoteFolderId }) {
            try { model.refreshFolders() }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { /* The saved ID remains usable if its display name is unavailable. */ }
        }
    }
    var page by rememberSaveable { mutableStateOf("sync") }
    var mode by rememberSaveable { mutableStateOf(SyncMode.MEDIA.name) }
    var folders by rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    var recursiveFolders by rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    var target by rememberSaveable { mutableStateOf<String?>(null) }
    var enableOnSave by rememberSaveable { mutableStateOf(false) }
    val notifier = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        allowed = FileAccess.granted(context)
    }
    fun requestAccess() {
        try { launcher.launch(FileAccess.requestIntent(context)) }
        catch (_: android.content.ActivityNotFoundException) {
            try { launcher.launch(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
            catch (_: android.content.ActivityNotFoundException) {
                scope.launch { notifier.showSnackbar(context.getString(R.string.df_permission_settings_missing)) }
            }
        }
    }
    fun edit(turnOn: Boolean) {
        mode = config.mode.name
        folders = ArrayList(config.localFolders)
        recursiveFolders = ArrayList(config.recursiveFolders)
        target = config.remoteFolderId
        enableOnSave = turnOn
        page = "edit"
    }
    fun back() { page = if (page == "local" || page == "cloud") "edit" else "sync" }
    BackHandler(page != "sync") { back() }
    Box(Modifier.fillMaxSize()) {
        AnimatedContent(page, Modifier.fillMaxSize(), transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "sync-page") { destination ->
            when (destination) {
                "sync" -> Dashboard(config, status, remoteLabel(config.remoteFolderId, model.cloudFolders), allowed,
                    onEdit = { edit(false) }, onRefresh = engine::rescan, onPermission = ::requestAccess,
                    onEnabled = { enabled ->
                        if (enabled && (!allowed || config.localFolders.isEmpty())) edit(true)
                        else engine.configure(config.copy(enabled = enabled))
                    })
                "edit" -> SyncEditor(SyncMode.valueOf(mode), folders, config.maxDepth, remoteLabel(target, model.cloudFolders),
                    allowed, ::requestAccess, { page = "local" }, { page = "cloud" }, ::back, onSave = {
                        engine.configure(engine.config.value.copy(localFolders = folders.toSet(), recursiveFolders = recursiveFolders.toSet(), remoteFolderId = target,
                            mode = SyncMode.valueOf(mode), enabled = enableOnSave || config.enabled))
                        page = "sync"
                    })
                "local" -> key(config.maxDepth) {
                    LocalPicker(SyncMode.valueOf(mode), folders.toSet(), recursiveFolders.toSet(), config.maxDepth,
                        allowed, ::requestAccess, ::back) { chosenMode, paths, recursive ->
                        mode = chosenMode.name
                        folders = ArrayList(paths)
                        recursiveFolders = ArrayList(recursive)
                        page = "edit"
                    }
                }
                "cloud" -> CloudPicker(model, target, ::back) { id -> target = id; page = "edit" }
            }
        }
        SnackbarHost(notifier, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
internal fun FoxMark(modifier: Modifier = Modifier.size(32.dp)) {
    Canvas(modifier) {
        fun patch(color: Color, vararg coords: Pair<Float, Float>) {
            val path = Path().apply {
                coords.forEachIndexed { index, (x, y) ->
                    if (index == 0) moveTo(x * size.width, y * size.height) else lineTo(x * size.width, y * size.height)
                }
                close()
            }
            drawPath(path, color)
        }
        patch(Color(0xFFF1A165), 0f to .04f, .34f to .25f, .7f to .25f, .48f to .7f, .12f to .66f)
        patch(Color(0xFFD06934), .34f to .25f, .67f to .25f, 1f to .04f, .88f to .67f, .5f to .98f, .4f to .67f)
        patch(Color(0xFFAC4720), .12f to .66f, .43f to .53f, .88f to .67f, .5f to .98f)
    }
}

@Composable
internal fun Header(title: String, onBack: (() -> Unit)? = null, action: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (onBack == null) FoxMark(Modifier.padding(start = 8.dp).size(30.dp))
        else IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, label(R.string.df_back)) }
        Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold)
        action()
    }
}

@Composable
private fun Login(model: DriveModel) {
    var register by rememberSaveable { mutableStateOf(false) }
    var server by rememberSaveable { mutableStateOf("") }
    var user by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    var reveal by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState())
        .padding(horizontal = 24.dp, vertical = 28.dp), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(modifier = Modifier.widthIn(max = 460.dp).fillMaxWidth(), shape = RoundedCornerShape(28.dp),
            tonalElevation = 1.dp, border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                FoxMark(Modifier.size(44.dp))
                Text("DragonFox Drive", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(label(if (register) R.string.df_register_intro else R.string.df_login_intro),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth().testTag("auth-server"), singleLine = true,
                    label = { Text(label(R.string.df_server)) }, placeholder = { Text("https://drive.example.com") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next))
                OutlinedTextField(user, { user = it }, Modifier.fillMaxWidth().testTag("auth-username"), singleLine = true,
                    label = { Text(label(R.string.df_username)) }, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next))
                OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth().testTag("auth-password"), singleLine = true,
                    label = { Text(label(R.string.df_password)) },
                    visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = if (register) ImeAction.Next else ImeAction.Done),
                    trailingIcon = { IconButton(onClick = { reveal = !reveal }) {
                        Icon(painterResource(if (reveal) R.drawable.df_eye_off else R.drawable.df_eye),
                            label(if (reveal) R.string.df_hide_password else R.string.df_show_password))
                    } })
                if (register) {
                    OutlinedTextField(confirmation, { confirmation = it }, Modifier.fillMaxWidth().testTag("auth-confirm"), singleLine = true,
                        label = { Text(label(R.string.df_confirm_password)) }, visualTransformation = PasswordVisualTransformation(),
                        isError = confirmation.isNotEmpty() && confirmation != password,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done))
                    Text(label(R.string.df_recovery_warning), style = MaterialTheme.typography.bodySmall)
                }
                model.authError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(onClick = { model.authenticate(server, user, password, register) }, modifier = Modifier.fillMaxWidth().testTag("auth-submit"),
                    enabled = !model.busy && user.isNotBlank() && server.isNotBlank() && password.isNotEmpty() && (!register || password == confirmation)) {
                    if (model.busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Text(label(if (register) R.string.df_create_account else R.string.df_sign_in))
                }
                TextButton(onClick = { register = !register; confirmation = ""; model.clearAuthError() }, enabled = !model.busy,
                    modifier = Modifier.align(Alignment.CenterHorizontally).testTag("auth-switch")) {
                    Text(label(if (register) R.string.df_existing_account else R.string.df_new_account))
                }
            }
        }
    }
}
