package dev.miao.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.miao.app.local.LocalAgent
import dev.miao.app.local.LocalImages
import dev.miao.app.local.LocalMessage
import dev.miao.app.local.LocalPresets
import dev.miao.app.local.LocalProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LocalScreen(agent: LocalAgent) {
    val listState = rememberLazyListState()
    var showSessions by rememberSaveable { mutableStateOf(false) }
    var showProviders by rememberSaveable { mutableStateOf(false) }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    var draft by rememberSaveable { mutableStateOf("") }
    val messages = agent.messages
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var attached by remember { mutableStateOf<List<String>>(emptyList()) }
    var attaching by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(LocalImages.MAX_IMAGES),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        attaching = true
        scope.launch {
            val encoded = withContext(Dispatchers.IO) {
                uris.take(LocalImages.MAX_IMAGES).mapNotNull { uri -> LocalImages.encode(context, uri) }
            }
            attached = (attached + encoded).take(LocalImages.MAX_IMAGES)
            attaching = false
        }
    }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("本机", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            agent.provider.name.ifEmpty { "未选择服务商" } +
                                if (agent.ready) "" else " · 需要配置",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    TextButton(onClick = { showSessions = true }) { Text("会话") }
                    TextButton(onClick = { showProviders = true }) { Text("服务商") }
                    TextButton(onClick = { showSettings = true }) { Text("设置") }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 2.dp) {
                Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    agent.error?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
                    if (attached.isNotEmpty() || attaching) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (attaching) Text("正在处理图片…", fontSize = 11.sp)
                            attached.forEachIndexed { index, image ->
                                Column(horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
                                    LocalImages.decode(image)?.let { bitmap ->
                                        Image(
                                            bitmap = bitmap.asImageBitmap(),
                                            contentDescription = "附件",
                                            contentScale = ContentScale.Crop,
                                            modifier = Modifier.size(56.dp),
                                        )
                                    }
                                    TextButton(onClick = { attached = attached.filterIndexed { i, _ -> i != index } }) {
                                        Text("移除", fontSize = 10.sp)
                                    }
                                }
                            }
                        }
                    }
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(if (agent.ready) "本机直连，不经过电脑…" else "先在「服务商」里配置接口与密钥") },
                        maxLines = 5,
                        enabled = agent.ready,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedButton(
                            onClick = {
                                picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            },
                            enabled = agent.ready && !agent.busy && attached.size < LocalImages.MAX_IMAGES,
                        ) { Text("图片") }
                        Button(
                            onClick = {
                                val text = draft
                                val images = attached
                                draft = ""
                                attached = emptyList()
                                agent.send(text, images)
                            },
                            enabled = agent.ready && !agent.busy && (draft.isNotBlank() || attached.isNotEmpty()),
                        ) { Text("发送") }
                        OutlinedButton(
                            onClick = { agent.retryLast() },
                            enabled = agent.ready && !agent.busy && messages.isNotEmpty(),
                        ) { Text("重试") }
                        OutlinedButton(onClick = { agent.newSession() }) { Text("新会话") }
                        Spacer(Modifier.weight(1f))
                        if (agent.busy) OutlinedButton(onClick = { agent.stop() }) { Text("停止") }
                    }
                }
            }
        },
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!agent.ready) {
                item { LocalIntro(agent) }
            }
            items(messages, key = { it.id }) { message -> LocalBubble(message) }
            item { Spacer(Modifier.height(12.dp)) }
        }
    }

    if (showSessions) {
        SessionsDialog(agent, onDismiss = { showSessions = false })
    }
    if (showProviders) {
        ProvidersDialog(agent, onDismiss = { showProviders = false })
    }
    if (showSettings) {
        var mcpField by remember(agent.mcpURL) { mutableStateOf(agent.mcpURL ?: "") }
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("本机设置") },
            text = {
                Column(
                    Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("工作区：${agent.workspace.path}", fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                    Row {
                        androidx.compose.material3.Checkbox(
                            checked = agent.autoAllowTools,
                            onCheckedChange = { agent.autoAllowTools = it },
                        )
                        Text("自动允许写入与联网（不再逐次确认）", fontSize = 12.sp)
                    }
                    OutlinedTextField(
                        value = mcpField,
                        onValueChange = { mcpField = it },
                        label = { Text("MCP 服务地址（可选，HTTP）") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { agent.setMcp(mcpField) }) { Text("保存并连接") }
                        OutlinedButton(
                            onClick = { agent.setMcp("") },
                            enabled = agent.mcpURL != null,
                        ) { Text("断开") }
                    }
                    Text(
                        when {
                            agent.mcpURL == null -> "未连接 MCP 服务"
                            agent.mcpError != null -> agent.mcpError ?: ""
                            agent.mcpTools.isEmpty() -> "正在连接…"
                            else -> "已连接 ${agent.mcpTools.size} 个 MCP 工具"
                        },
                        fontSize = 11.sp,
                        color = if (agent.mcpError != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { showSettings = false }) { Text("关闭") }
            },
        )
    }
    agent.approval?.let { approval ->
        AlertDialog(
            onDismissRequest = { agent.resolve(false) },
            title = { Text("允许执行 ${approval.tool}？") },
            text = { Text(approval.detail, fontSize = 11.sp, fontFamily = FontFamily.Monospace) },
            confirmButton = { TextButton(onClick = { agent.resolve(true) }) { Text("允许") } },
            dismissButton = { TextButton(onClick = { agent.resolve(false) }) { Text("拒绝") } },
        )
    }
}

@Composable
private fun LocalIntro(agent: LocalAgent) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("手机自己就能用", style = MaterialTheme.typography.titleMedium)
            Text(
                "在「服务商」里填入一个 OpenAI 兼容接口（预置了常见服务商）后，本机会话直接在手机上运行，" +
                    "工具只能读写应用自己的工作区。",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun LocalBubble(message: LocalMessage) {
    when (message.role) {
        LocalMessage.Role.User -> Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                message.images.forEach { image ->
                    LocalImages.decode(image)?.let { bitmap ->
                        Image(
                            bitmap = bitmap.asImageBitmap(),
                            contentDescription = "附件",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp),
                        )
                    }
                }
                Text(message.text, fontSize = 14.sp)
            }
        }
        LocalMessage.Role.Assistant -> Card(modifier = Modifier.fillMaxWidth()) {
            Text(message.text, fontSize = 14.sp, modifier = Modifier.padding(10.dp))
        }
        LocalMessage.Role.Tool -> Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp)) {
                Text("工具 ${message.toolName ?: ""}", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(message.text, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun SessionsDialog(agent: LocalAgent, onDismiss: () -> Unit) {
    var renameID by remember { mutableStateOf<String?>(null) }
    var showRename by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("本机会话") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                agent.sessions.forEach { session ->
                    val current = session.id == agent.currentID
                    Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        TextButton(onClick = {
                            agent.selectSession(session.id)
                            onDismiss()
                        }) {
                            Text((if (current) "✓ " else "") + (session.title.ifEmpty { "新会话" }))
                        }
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = {
                            renameID = session.id
                            showRename = true
                        }) { Text("改名") }
                        TextButton(onClick = { agent.deleteSession(session.id) }) { Text("删除") }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                agent.newSession()
                onDismiss()
            }) { Text("新会话") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
    val id = renameID
    if (showRename && id != null) {
        var title by remember(id) {
            mutableStateOf(agent.sessions.firstOrNull { it.id == id }?.title ?: "")
        }
        AlertDialog(
            onDismissRequest = { showRename = false },
            title = { Text("重命名会话") },
            text = { OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = {
                    agent.renameSession(id, title)
                    showRename = false
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { showRename = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun ProvidersDialog(agent: LocalAgent, onDismiss: () -> Unit) {
    var editing by remember { mutableStateOf<LocalProvider?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("服务商") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                agent.providers.forEach { provider ->
                    val selected = provider.id == agent.selectedID
                    Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        TextButton(onClick = { agent.select(provider.id) }) {
                            Text((if (selected) "✓ " else "") + (provider.name.ifEmpty { provider.baseURL }), maxLines = 1)
                        }
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = { editing = provider }) { Text("编辑") }
                        TextButton(onClick = { agent.remove(provider.id) }) { Text("删除") }
                    }
                    Text(provider.model, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = { editing = LocalProvider() }) { Text("添加服务商") }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
    editing?.let { provider ->
        ProviderEditor(agent, provider) { editing = null }
    }
}

@Composable
private fun ProviderEditor(agent: LocalAgent, initial: LocalProvider, onDismiss: () -> Unit) {
    var name by rememberSaveable(initial.id) { mutableStateOf(initial.name) }
    var baseURL by rememberSaveable(initial.id) { mutableStateOf(initial.baseURL) }
    var model by rememberSaveable(initial.id) { mutableStateOf(initial.model) }
    var apiKey by rememberSaveable(initial.id) { mutableStateOf(initial.apiKey) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial.name.isEmpty()) "添加服务商" else "编辑服务商") },
        text = {
            Column(
                Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("预置", fontSize = 11.sp)
                LocalPresets.all.forEach { preset ->
                    FilterChip(
                        selected = baseURL == preset.baseURL,
                        onClick = {
                            name = preset.name
                            baseURL = preset.baseURL
                            model = preset.defaultModel
                        },
                        label = { Text(preset.name) },
                    )
                }
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = baseURL,
                    onValueChange = { baseURL = it },
                    label = { Text("接口地址（OpenAI 兼容）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = model,
                    onValueChange = { model = it },
                    label = { Text("模型") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    label = { Text("API Key") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("密钥只保存在本机应用私有目录。", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    agent.save(initial.copy(name = name, baseURL = baseURL, model = model, apiKey = apiKey))
                    onDismiss()
                },
                enabled = baseURL.isNotBlank() && model.isNotBlank(),
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
