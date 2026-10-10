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
            TopAppBar(title = { Text("FileHop", fontWeight = FontWeight.Bold) }, actions = {
                if (screen.phase == Phase.Ready) {
                    TextButton(onClick = { editLabel = true }) { Text("来源") }
                    TextButton(onClick = { logout = true }) { Text("退出") }
                }
            })
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = 20.dp)) {
            if (screen.notice.isNotEmpty()) {
                Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(screen.notice, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
                }
            }
            when (screen.phase) {
                Phase.Configure -> Configure(vm)
                Phase.Login -> Login(screen, vm)
                Phase.Checking -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (screen.loggingIn) LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("检查登录状态")
                    Button(onClick = vm::restore, enabled = !screen.loggingIn) { Text("重试") }
                    TextButton(onClick = vm::logout) { Text("退出本机登录") }
                }
                Phase.Ready -> Messages(screen, vm)
            }
        }
    }
    if (logout) AlertDialog(onDismissRequest = { logout = false }, title = { Text("退出登录？") },
        text = { Text("本机草稿和未确认发送信息将清除，服务器上已保存的消息不受影响。") },
        confirmButton = { TextButton(onClick = { logout = false; vm.logout() }) { Text("退出") } },
        dismissButton = { TextButton(onClick = { logout = false }) { Text("取消") } })
    if (editLabel && screen.phase == Phase.Ready) {
        var label by remember { mutableStateOf(screen.label) }
        AlertDialog(onDismissRequest = { editLabel = false }, title = { Text("来源标签") },
            text = { OutlinedTextField(label, { label = it }, label = { Text("名称") }, singleLine = true) },
            confirmButton = { TextButton(onClick = { vm.label(label); if (TextRules.label(label) != null) editLabel = false }) { Text("保存") } },
            dismissButton = { TextButton(onClick = { editLabel = false }) { Text("取消") } })
    }
}

@Composable
private fun Configure(vm: HopViewModel) {
    var origin by remember { mutableStateOf(BuildConfig.DEFAULT_ORIGIN) }
    var confirm by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("连接你的服务器", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(origin, { origin = it }, modifier = Modifier.fillMaxWidth(),
            label = { Text("HTTPS 服务器地址") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        Text("确认后固定使用此地址。更换服务器需清除应用数据。", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = { confirm = true }, enabled = TextRules.origin(origin) != null) { Text("继续") }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text("确认服务器") },
        text = { Text(TextRules.origin(origin).orEmpty()) },
        confirmButton = { TextButton(onClick = { confirm = false; vm.configure(origin) }) { Text("确认") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("返回") } })
}

@Composable
private fun Login(screen: Screen, vm: HopViewModel) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("登录", style = MaterialTheme.typography.headlineMedium)
        Text(screen.origin, style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(username, { username = it }, label = { Text("用户名") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(), enabled = !screen.loggingIn)
        OutlinedTextField(password, { password = it }, label = { Text("密码") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(), enabled = !screen.loggingIn)
        Button(onClick = { val value = password; password = ""; vm.login(username, value) },
            enabled = !screen.loggingIn && username.isNotEmpty() && password.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
            Text(if (screen.loggingIn) "正在登录" else "登录")
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
        Text("消息", style = MaterialTheme.typography.titleLarge)
        TextButton(onClick = { vm.refresh() }, enabled = !screen.reading) { Text("刷新") }
    }
    if (screen.hasOlder) TextButton(onClick = { vm.refresh(older = true) }, enabled = !screen.reading) { Text("加载更早消息") }
    if (screen.reading) LinearProgressIndicator(Modifier.fillMaxWidth())
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(vertical = 12.dp)) {
        items(screen.messages, key = { it.id }) { message ->
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow,
                modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(message.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    Text(if (message.kind == "TEXT") message.text else message.fileName, style = MaterialTheme.typography.bodyLarge)
                    if (message.kind != "TEXT") Text("暂不支持在此版本打开文件", style = MaterialTheme.typography.bodySmall)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text(message.time, style = MaterialTheme.typography.labelSmall)
                        if (message.kind == "TEXT") TextButton(onClick = {
                            try {
                                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                clipboard.setPrimaryClip(ClipData.newPlainText("", message.text))
                                vm.feedback("已复制正文")
                            } catch (_: Exception) { vm.feedback("复制失败，请重试") }
                        }) { Text("复制") }
                    }
                }
            }
        }
        if (screen.messages.isEmpty() && !screen.reading) item { Text("还没有消息", style = MaterialTheme.typography.bodyLarge) }
    }
    if (!nearBottom) TextButton(onClick = { scope.launch { if (screen.messages.isNotEmpty()) list.animateScrollToItem(screen.messages.lastIndex) } }) { Text("回到最新") }
    var abandon by remember { mutableStateOf(false) }
    if (screen.pending != null) {
        Text(if (screen.sending) "正在处理发送" else "发送结果未确认", style = MaterialTheme.typography.labelLarge)
        Row {
            TextButton(onClick = { vm.resolve(query = true) }, enabled = !screen.sending) { Text("查询结果") }
            TextButton(onClick = { vm.resolve(query = false) }, enabled = !screen.sending) { Text("同次重试") }
            TextButton(onClick = { abandon = true }, enabled = !screen.sending) { Text("放弃确认") }
        }
    }
    OutlinedTextField(screen.draft, vm::draft, modifier = Modifier.fillMaxWidth(), label = { Text("消息正文") },
        enabled = screen.pending == null, minLines = 2, maxLines = 5)
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text("${screen.draft.toByteArray(Charsets.UTF_8).size} / 65,536 字节", style = MaterialTheme.typography.labelSmall)
        Button(onClick = vm::send, enabled = screen.pending == null && TextRules.validText(screen.draft)) { Text("发送") }
    }
    if (abandon) AlertDialog(onDismissRequest = { abandon = false }, title = { Text("放弃确认？") },
        text = { Text("原消息可能已经保存，请先检查历史。放弃不是撤回，再次发送可能重复。") },
        confirmButton = { TextButton(onClick = { abandon = false; vm.abandon() }) { Text("放弃确认") } },
        dismissButton = { TextButton(onClick = { abandon = false }) { Text("取消") } })
}
