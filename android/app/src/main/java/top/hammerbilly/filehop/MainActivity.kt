package top.hammerbilly.filehop

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFF7DDACB))
                else lightColorScheme(primary = Color(0xFF006B5E), surface = Color(0xFFF8FAF9))
            MaterialTheme(colorScheme = colors) { FileHop() }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FileHop(vm: HopViewModel = viewModel()) {
    val screen = vm.screen
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, vm) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> vm.foreground(true)
                Lifecycle.Event.ON_STOP -> vm.foreground(false)
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        vm.foreground(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
        onDispose { lifecycle.removeObserver(observer); vm.foreground(false) }
    }
    var logout by remember { mutableStateOf(false) }
    var editLabel by remember { mutableStateOf(false) }
    Scaffold(
        topBar = {
            TopAppBar(title = { Text(stringResource(R.string.app_name), fontWeight = FontWeight.Bold) }, actions = {
                if (screen.phase == Phase.Ready) {
                    TextButton(onClick = { editLabel = true }) { Text(stringResource(R.string.action_source_label)) }
                    TextButton(onClick = { logout = true }) { Text(stringResource(R.string.action_logout)) }
                }
            })
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = 20.dp)) {
            screen.noticeRes?.let { notice ->
                Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(stringResource(notice), Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
                }
            }
            when (screen.phase) {
                Phase.Configure -> Configure(vm)
                Phase.Login -> Login(screen, vm)
                Phase.Checking -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (screen.loggingIn) LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(stringResource(R.string.session_checking))
                    Button(onClick = vm::restore, enabled = !screen.loggingIn) { Text(stringResource(R.string.action_retry)) }
                    TextButton(onClick = vm::logout) { Text(stringResource(R.string.action_logout_local)) }
                }
                Phase.Ready -> Messages(screen, vm)
            }
        }
    }
    if (logout) AlertDialog(onDismissRequest = { logout = false }, title = { Text(stringResource(R.string.logout_title)) },
        text = { Text(stringResource(R.string.logout_message)) },
        confirmButton = { TextButton(onClick = { logout = false; vm.logout() }) { Text(stringResource(R.string.action_logout)) } },
        dismissButton = { TextButton(onClick = { logout = false }) { Text(stringResource(R.string.action_cancel)) } })
    if (editLabel && screen.phase == Phase.Ready) {
        var label by remember { mutableStateOf(screen.label) }
        AlertDialog(onDismissRequest = { editLabel = false }, title = { Text(stringResource(R.string.source_label_title)) },
            text = { OutlinedTextField(label, { label = it }, label = { Text(stringResource(R.string.source_label_name)) }, singleLine = true) },
            confirmButton = { TextButton(onClick = { vm.label(label); if (TextRules.label(label) != null) editLabel = false }) { Text(stringResource(R.string.action_save)) } },
            dismissButton = { TextButton(onClick = { editLabel = false }) { Text(stringResource(R.string.action_cancel)) } })
    }
}

@Composable
private fun Configure(vm: HopViewModel) {
    var origin by remember { mutableStateOf(BuildConfig.DEFAULT_ORIGIN) }
    var confirm by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.configure_title), style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(origin, { origin = it }, modifier = Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.server_address_label)) }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        Text(stringResource(R.string.server_address_hint), style = MaterialTheme.typography.bodyMedium)
        Button(onClick = { confirm = true }, enabled = TextRules.origin(origin) != null) { Text(stringResource(R.string.action_continue)) }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text(stringResource(R.string.server_confirm_title)) },
        text = { Text(TextRules.origin(origin).orEmpty()) },
        confirmButton = { TextButton(onClick = { confirm = false; vm.configure(origin) }) { Text(stringResource(R.string.action_confirm)) } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.action_back)) } })
}

@Composable
private fun Login(screen: Screen, vm: HopViewModel) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.action_login), style = MaterialTheme.typography.headlineMedium)
        Text(screen.origin, style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(username, { username = it }, label = { Text(stringResource(R.string.username_label)) }, singleLine = true,
            modifier = Modifier.fillMaxWidth(), enabled = !screen.loggingIn)
        OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.password_label)) }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(), enabled = !screen.loggingIn)
        Button(onClick = { val value = password; password = ""; vm.login(username, value) },
            enabled = !screen.loggingIn && username.isNotEmpty() && password.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(if (screen.loggingIn) R.string.login_in_progress else R.string.action_login))
        }
    }
}

@Composable
private fun ColumnScope.Messages(screen: Screen, vm: HopViewModel) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val nearBottom by remember { derivedStateOf {
        list.layoutInfo.totalItemsCount == 0 || (list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= list.layoutInfo.totalItemsCount - 2
    } }
    var initiallyPositioned by remember { mutableStateOf(false) }
    LaunchedEffect(screen.messages.lastOrNull()?.id) {
        if (screen.messages.isNotEmpty()) {
            if (!initiallyPositioned) list.scrollToItem(screen.messages.lastIndex)
            else if (nearBottom) list.animateScrollToItem(screen.messages.lastIndex)
            initiallyPositioned = true
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.messages_title), style = MaterialTheme.typography.titleLarge)
        TextButton(onClick = { vm.refresh() }, enabled = !screen.reading) { Text(stringResource(R.string.action_refresh)) }
    }
    if (screen.hasOlder) TextButton(onClick = { vm.refresh(older = true) }, enabled = !screen.reading) { Text(stringResource(R.string.action_load_older)) }
    if (screen.reading) LinearProgressIndicator(Modifier.fillMaxWidth())
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(vertical = 12.dp)) {
        items(screen.messages, key = { it.id }) { message ->
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow,
                modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(message.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    Text(if (message.kind == "TEXT") message.text else message.fileName, style = MaterialTheme.typography.bodyLarge)
                    if (message.kind != "TEXT") Text(stringResource(R.string.file_not_supported), style = MaterialTheme.typography.bodySmall)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text(message.time, style = MaterialTheme.typography.labelSmall)
                        if (message.kind == "TEXT") TextButton(onClick = {
                            try {
                                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                clipboard.setPrimaryClip(ClipData.newPlainText("", message.text))
                                vm.feedback(R.string.notice_copy_success)
                            } catch (_: Exception) { vm.feedback(R.string.notice_copy_failed) }
                        }) { Text(stringResource(R.string.action_copy)) }
                    }
                }
            }
        }
        if (screen.messages.isEmpty() && !screen.reading) item { Text(stringResource(R.string.messages_empty), style = MaterialTheme.typography.bodyLarge) }
    }
    if (!nearBottom) TextButton(onClick = { scope.launch { if (screen.messages.isNotEmpty()) list.animateScrollToItem(screen.messages.lastIndex) } }) { Text(stringResource(R.string.action_scroll_latest)) }
    var abandon by remember { mutableStateOf(false) }
    if (screen.pending != null) {
        Text(stringResource(if (screen.sending) R.string.send_in_progress else R.string.send_unconfirmed), style = MaterialTheme.typography.labelLarge)
        Row {
            TextButton(onClick = { vm.resolve(query = true) }, enabled = !screen.sending) { Text(stringResource(R.string.action_query_result)) }
            TextButton(onClick = { vm.resolve(query = false) }, enabled = !screen.sending) { Text(stringResource(R.string.action_retry_same_send)) }
            TextButton(onClick = { abandon = true }, enabled = !screen.sending) { Text(stringResource(R.string.action_abandon_confirmation)) }
        }
    }
    OutlinedTextField(screen.draft, vm::draft, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.message_body_label)) },
        enabled = screen.pending == null, minLines = 2, maxLines = 5)
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.message_byte_count, screen.draft.toByteArray(Charsets.UTF_8).size), style = MaterialTheme.typography.labelSmall)
        Button(onClick = vm::send, enabled = screen.pending == null && TextRules.validText(screen.draft)) { Text(stringResource(R.string.action_send)) }
    }
    if (abandon) AlertDialog(onDismissRequest = { abandon = false }, title = { Text(stringResource(R.string.abandon_title)) },
        text = { Text(stringResource(R.string.abandon_message)) },
        confirmButton = { TextButton(onClick = { abandon = false; vm.abandon() }) { Text(stringResource(R.string.action_abandon_confirmation)) } },
        dismissButton = { TextButton(onClick = { abandon = false }) { Text(stringResource(R.string.action_cancel)) } })
}
