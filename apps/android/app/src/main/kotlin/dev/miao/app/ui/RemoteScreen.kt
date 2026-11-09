package dev.miao.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.miao.app.AppModel
import dev.miao.app.HostClient
import dev.miao.app.InboxEntry
import dev.miao.app.SessionSummary
import dev.miao.core.JsonValue
import dev.miao.core.OperationKind
import dev.miao.core.OperationTarget
import dev.miao.core.RemoteMethod
import dev.miao.core.RemotePermission
import kotlinx.coroutines.launch

@Composable
fun MiaoRoot(model: AppModel) {
    var showAccount by rememberSaveable { mutableStateOf(false) }
    var showPairing by rememberSaveable { mutableStateOf(false) }
    var pairingLink by rememberSaveable { mutableStateOf("") }
    var providersHost by remember { mutableStateOf<HostClient?>(null) }
    var openSession by remember { mutableStateOf<Pair<HostClient, SessionSummary>?>(null) }

    LaunchedEffect(model.incomingPairLink) {
        val link = model.incomingPairLink ?: return@LaunchedEffect
        pairingLink = link
        showPairing = true
        model.incomingPairLink = null
    }

    val session = openSession
    if (session != null) {
        val remote = remember(session.first, session.second) { session.first.session(session.second) }
        SessionScreen(remote, onBack = { openSession = null })
        return
    }

    RemoteScreen(
        model = model,
        onOpenAccount = { showAccount = true },
        onPair = { showPairing = true },
        onProviders = { providersHost = it },
        onOpenSession = { client, summary -> openSession = client to summary },
    )

    if (showAccount) AccountDialog(model, onDismiss = { showAccount = false })
    if (showPairing) {
        PairingDialog(
            model = model,
            initialLink = pairingLink,
            onDismiss = {
                showPairing = false
                model.cancelPairing()
            },
        )
    }
    providersHost?.let { host -> ProvidersDialog(host, onDismiss = { providersHost = null }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteScreen(
    model: AppModel,
    onOpenAccount: () -> Unit,
    onPair: () -> Unit,
    onProviders: (HostClient) -> Unit,
    onOpenSession: (HostClient, SessionSummary) -> Unit,
) {
    var hostsExpanded by rememberSaveable { mutableStateOf(true) }

    LaunchedEffect(model.hosts) {
        model.hosts.forEach { record ->
            val client = model.hostClient(record.id) ?: return@forEach
            if (client.ready) {
                client.loadInbox()
                client.loadProviders()
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("电脑") },
                actions = {
                    TextButton(onClick = onOpenAccount) { Text("账号") }
                    TextButton(onClick = { hostsExpanded = !hostsExpanded }) {
                        Text(if (hostsExpanded) "收起" else "展开")
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onPair) { Text("配对") }
        },
    ) { padding ->
        if (!model.accountSignedIn) {
            SignInPrompt(padding, onOpenAccount)
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { AccountSummary(model) }
            val inbox = model.hosts.flatMap { record ->
                model.hostClient(record.id)?.inbox ?: emptyList()
            }
            if (inbox.isNotEmpty()) {
                item { InboxCard(inbox) }
            }
            if (model.hosts.isEmpty()) {
                item { EmptyHosts() }
            }
            items(model.hosts, key = { it.id }) { record ->
                val client = model.hostClient(record.id) ?: return@items
                HostCard(
                    client = client,
                    expanded = hostsExpanded,
                    onToggle = { hostsExpanded = !hostsExpanded },
                    onProviders = { onProviders(client) },
                    onOpenSession = { summary -> onOpenSession(client, summary) },
                    onForget = { model.forget(record.id) },
                )
            }
            item { Spacer(Modifier.height(80.dp)) }
        }
    }
    model.error?.let { message ->
        AlertDialog(
            onDismissRequest = { model.error = null },
            confirmButton = { TextButton(onClick = { model.error = null }) { Text("知道了") } },
            text = { Text(message) },
        )
    }
}

@Composable
private fun SignInPrompt(padding: PaddingValues, onOpenAccount: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("登录中继", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            "手机通过电脑使用的中继访问你的会话。登录后即可扫码配对或接入同账号电脑。",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = onOpenAccount) { Text("登录账号") }
    }
}

@Composable
private fun AccountSummary(model: AppModel) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("中继账号", style = MaterialTheme.typography.titleSmall)
            Text(model.accountURL, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            model.accountError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { model.refreshDirectory() }) { Text("刷新电脑") }
                OutlinedButton(onClick = { model.connectAccountDevices() }) { Text("接入同账号电脑") }
            }
        }
    }
}

@Composable
private fun EmptyHosts() {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("还没有电脑", style = MaterialTheme.typography.titleMedium)
            Text(
                "在电脑上运行 /remote-control 并扫码配对；同账号电脑可在一键接入后直接出现。",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun InboxCard(entries: List<InboxEntry>) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("等待你的处理", style = MaterialTheme.typography.titleSmall)
            entries.forEach { entry ->
                Text(
                    "${entry.title} · ${entry.summary}",
                    fontSize = 13.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun HostCard(
    client: HostClient,
    expanded: Boolean,
    onToggle: () -> Unit,
    onProviders: () -> Unit,
    onOpenSession: (SessionSummary) -> Unit,
    onForget: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var search by rememberSaveable { mutableStateOf("") }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var menuFor by remember { mutableStateOf<SessionSummary?>(null) }
    var showRename by remember { mutableStateOf<SessionSummary?>(null) }
    var showCreate by remember { mutableStateOf(false) }

    val sessions = client.lists.entries.flatMap { it.value }
        .distinctBy { it.id }
        .filter { showArchived || !it.archived }
        .filter { search.isEmpty() || it.title.contains(search, ignoreCase = true) }
        .sortedByDescending { it.pinned }

    LaunchedEffect(client.ready) {
        if (client.ready) {
            client.refreshLists()
            client.loadInbox()
        }
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        client.record.host.label.ifEmpty { client.record.host.target.hostID },
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        client.connectionDescription(),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onToggle) { Text(if (expanded) "收起" else "会话") }
                if (client.canConfigureProviders) TextButton(onClick = onProviders) { Text("模型") }
                TextButton(onClick = onForget) { Text("移除") }
            }
            if (!expanded) return@Card
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = search,
                    onValueChange = {
                        search = it
                        scope.launch { client.refreshLists(search = it.ifEmpty { null }) }
                    },
                    label = { Text("搜索会话") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                FilterChip(
                    selected = showArchived,
                    onClick = { showArchived = !showArchived },
                    label = { Text("归档") },
                )
            }
            if (sessions.isEmpty()) {
                Text("没有可显示的会话", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            sessions.forEach { summary ->
                DropdownMenu(expanded = menuFor?.id == summary.id, onDismissRequest = { menuFor = null }) {
                    DropdownMenuItem(
                        text = { Text(if (summary.pinned) "取消置顶" else "置顶") },
                        onClick = {
                            menuFor = null
                            scope.launch {
                                client.session(summary).pin(!summary.pinned)
                                client.refreshLists()
                            }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(if (summary.archived) "取消归档" else "归档") },
                        onClick = {
                            menuFor = null
                            scope.launch {
                                client.session(summary).archive(!summary.archived)
                                client.refreshLists()
                            }
                        },
                    )
                    if (RemotePermission.SessionDelete in client.record.grant.permissions) {
                        DropdownMenuItem(
                            text = { Text("永久删除") },
                            onClick = {
                                menuFor = null
                                scope.launch {
                                    client.session(summary).command(RemoteMethod.SessionRemove, OperationKind.SessionRemove, JsonValue.obj())
                                    client.refreshLists()
                                }
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text("重命名") },
                        onClick = {
                            menuFor = null
                            showRename = summary
                        },
                    )
                }
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .combinedClickable(onClick = { onOpenSession(summary) }, onLongClick = { menuFor = summary }),
                    shape = MaterialTheme.shapes.small,
                ) {
                    Column(Modifier.padding(vertical = 6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (summary.pinned) {
                                AssistChip(onClick = {}, label = { Text("置顶") })
                                Spacer(Modifier.width(6.dp))
                            }
                            Text(summary.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (client.sending(summary.id)) {
                            Text("发送中…", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            TextButton(onClick = { showCreate = true }) { Text("新建会话") }
        }
    }

    showRename?.let { summary ->
        var title by remember(summary.id) { mutableStateOf(summary.title) }
        AlertDialog(
            onDismissRequest = { showRename = null },
            title = { Text("重命名会话") },
            text = { OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = {
                    showRename = null
                    scope.launch {
                        client.session(summary).rename(title)
                        client.refreshLists()
                    }
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { showRename = null }) { Text("取消") } },
        )
    }

    if (showCreate) CreateSessionDialog(client, onDismiss = { showCreate = false })
}

@Composable
private fun CreateSessionDialog(client: HostClient, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var selectedProject by remember { mutableStateOf<JsonValue?>(null) }
    val projects = client.projects
    val project = selectedProject ?: projects.firstOrNull()
    val directories = project?.get("directories")?.array ?: emptyList()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建会话") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                projects.forEach { value ->
                    val name = value["name"]?.string ?: value["id"]?.string ?: "项目"
                    FilterChip(
                        selected = project === value,
                        onClick = { selectedProject = value },
                        label = { Text(name) },
                    )
                }
                directories.forEach { directory ->
                    val id = directory["id"]?.string ?: return@forEach
                    OutlinedButton(onClick = {
                        onDismiss()
                        scope.launch {
                            client.mutate(
                                RemoteMethod.SessionCreate,
                                OperationKind.SessionCreate,
                                OperationTarget.ofProject(
                                    client.record.host.target.hostID,
                                    client.runtime,
                                    project?.get("id")?.string ?: return@launch,
                                ),
                                JsonValue.obj("directoryID" to JsonValue.of(id)),
                            )
                            client.refreshLists()
                        }
                    }) {
                        Text(directory["name"]?.string ?: id.take(8))
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
