package dev.miao.app.ui

import android.content.Context
import android.content.Intent
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.miao.app.RemoteSession
import dev.miao.core.JsonValue
import dev.miao.core.OperationKind
import dev.miao.core.RemoteMethod
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(remote: RemoteSession, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var showRename by rememberSaveable { mutableStateOf(false) }
    var showDiff by rememberSaveable { mutableStateOf(false) }
    var speech by remember { mutableStateOf(false) }

    DisposableEffect(remote) {
        remote.appear()
        onDispose { remote.disappear() }
    }

    val messages = remote.visibleMessages
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(remote.summary.title.ifEmpty { "会话" }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (remote.loading) Text("同步中…", fontSize = 11.sp)
                        else remote.error?.let { Text(it, fontSize = 10.sp, color = MaterialTheme.colorScheme.error) }
                    }
                },
                navigationIcon = { TextButton(onClick = onBack) { Text("返回") } },
                actions = {
                    TextButton(onClick = { showRename = true }) { Text("重命名") }
                    TextButton(onClick = { showDiff = true }) { Text("变更") }
                },
            )
        },
        bottomBar = {
            Composer(
                remote = remote,
                speechActive = speech,
                onSpeech = { speech = !speech },
                onSend = { _, _ -> },
            )
        },
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(messages) { message -> MessageCard(message) }
            item { PendingCard(remote) }
            item { Spacer(Modifier.height(12.dp)) }
        }
    }

    if (showRename) {
        var title by rememberSaveable { mutableStateOf(remote.summary.title) }
        AlertDialog(
            onDismissRequest = { showRename = false },
            title = { Text("重命名会话") },
            text = { OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = {
                    showRename = false
                    scope.launch { remote.rename(title) }
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { showRename = false }) { Text("取消") } },
        )
    }

    if (showDiff) {
        LaunchedEffect(Unit) { remote.loadDiff() }
        AlertDialog(
            onDismissRequest = { showDiff = false },
            title = { Text("文件变更") },
            text = {
                Text(
                    remote.diff?.let { renderDiff(it) } ?: "正在读取…",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                )
            },
            confirmButton = { TextButton(onClick = { showDiff = false }) { Text("关闭") } },
        )
    }
}

@Composable
private fun Composer(
    remote: RemoteSession,
    speechActive: Boolean,
    onSpeech: () -> Unit,
    onSend: (String, Boolean) -> Unit,
) {
    val execution = remote.pending["execution"]?.takeIf { it["type"]?.string == "running" }
    val scope = rememberCoroutineScope()
    Surface(tonalElevation = 2.dp) {
        Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(
                value = remote.draft,
                onValueChange = { remote.edit(it) },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("输入消息…") },
                maxLines = 6,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(
                    onClick = { scope.launch { remote.send(queue = false) } },
                    enabled = remote.draft.isNotBlank(),
                ) { Text("发送") }
                OutlinedButton(
                    onClick = { scope.launch { remote.send(queue = true) } },
                    enabled = remote.draft.isNotBlank(),
                ) { Text("排队") }
                OutlinedButton(onClick = onSpeech) { Text(if (speechActive) "说…" else "语音") }
                Spacer(Modifier.weight(1f))
                if (execution != null) {
                    OutlinedButton(onClick = {
                        scope.launch { remote.interrupt(execution["executionID"]?.string) }
                    }) { Text("中断") }
                }
            }
        }
    }
    if (speechActive) SpeechCapture(remote, onSpeech)
}

@Composable
private fun SpeechCapture(remote: RemoteSession, onDone: () -> Unit) {
    val context = LocalContext.current
    val recognizer = remember { SpeechRecognizer.createSpeechRecognizer(context) }
    DisposableEffect(recognizer) {
        onDispose { recognizer.destroy() }
    }
    LaunchedEffect(Unit) {
        val text = captureSpeech(recognizer)
        if (!text.isNullOrBlank()) remote.edit(remote.draft + text)
        onDone()
    }
}

private suspend fun captureSpeech(recognizer: SpeechRecognizer): String? = suspendCancellableCoroutine { continuation ->
    val listener = object : RecognitionListener {
        override fun onResults(results: android.os.Bundle?) {
            val values = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            if (continuation.isActive) continuation.resumeWith(Result.success(values?.firstOrNull()))
        }

        override fun onError(error: Int) {
            if (continuation.isActive) continuation.resumeWith(Result.success(null))
        }

        override fun onReadyForSpeech(params: android.os.Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onPartialResults(partialResults: android.os.Bundle?) = Unit
        override fun onEvent(eventType: Int, params: android.os.Bundle?) = Unit
    }
    recognizer.setRecognitionListener(listener)
    recognizer.startListening(
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        },
    )
    continuation.invokeOnCancellation { recognizer.stopListening() }
}

@Composable
private fun MessageCard(message: Map<String, JsonValue>) {
    val type = message["type"]?.string ?: "system"
    when (type) {
        "user" -> Card(modifier = Modifier.fillMaxWidth()) {
            Text(textOf(message), fontSize = 14.sp, modifier = Modifier.padding(10.dp))
        }
        "assistant" -> AssistantCard(message)
        "tool" -> Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp)) {
                Text("工具 " + (message["name"]?.string ?: ""), fontSize = 12.sp)
                Text(renderValue(message["state"] ?: JsonValue.Obj(emptyMap())), fontSize = 10.sp, fontFamily = FontFamily.Monospace)
            }
        }
        "shell" -> Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp)) {
                Text("$ " + (message["command"]?.string ?: ""), fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                Text(message["output"]?.string ?: "", fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            }
        }
        "compaction" -> Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp)) {
                Text("摘要", style = MaterialTheme.typography.labelMedium)
                Text(message["summary"]?.string ?: "", fontSize = 12.sp)
            }
        }
        "agent-switched", "model-switched" -> Card(modifier = Modifier.fillMaxWidth()) {
            Text(
                type.replace("-switched", "") + " → " +
                    (message["agent"]?.string ?: message["model"]?.get("id")?.string ?: ""),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(8.dp),
            )
        }
        else -> Card(modifier = Modifier.fillMaxWidth()) {
            Text(textOf(message), fontSize = 12.sp, modifier = Modifier.padding(8.dp))
        }
    }
}

@Composable
private fun AssistantCard(message: Map<String, JsonValue>) {
    val content = message["content"]?.array ?: emptyList()
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            message["model"]?.get("id")?.string?.let {
                Text(it, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            content.forEach { part ->
                when (part["type"]?.string) {
                    "text" -> Text(part["text"]?.string ?: "", fontSize = 14.sp)
                    "reasoning" -> Text(
                        part["text"]?.string ?: "",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    "tool" -> {
                        val state = part["state"]
                        Text(
                            "工具 ${part["name"]?.string ?: ""} · ${state?.get("status")?.string ?: "pending"}",
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                        state?.get("input")?.let { Text(renderValue(it), fontSize = 10.sp, fontFamily = FontFamily.Monospace) }
                        state?.get("content")?.array?.forEach { item ->
                            Text(item["text"]?.string ?: "", fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                        }
                        state?.get("error")?.let {
                            Text(renderValue(it), fontSize = 10.sp, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PendingCard(remote: RemoteSession) {
    val scope = rememberCoroutineScope()
    val permissions = remote.pending["permissions"]?.array ?: emptyList()
    val questions = remote.pending["questions"]?.array ?: emptyList()
    if (permissions.isEmpty() && questions.isEmpty()) return
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("等待你处理", style = MaterialTheme.typography.titleSmall)
            permissions.forEach { permission ->
                val id = permission["id"]?.string ?: return@forEach
                Text(permission["action"]?.string ?: renderValue(permission), fontSize = 12.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(onClick = {
                        scope.launch {
                            remote.reply(
                                RemoteMethod.PermissionReply,
                                OperationKind.PermissionReply,
                                JsonValue.obj("requestID" to JsonValue.of(id), "reply" to JsonValue.of("once")),
                            )
                        }
                    }) { Text("允许一次") }
                    OutlinedButton(onClick = {
                        scope.launch {
                            remote.reply(
                                RemoteMethod.PermissionReply,
                                OperationKind.PermissionReply,
                                JsonValue.obj("requestID" to JsonValue.of(id), "reply" to JsonValue.of("reject")),
                            )
                        }
                    }) { Text("拒绝") }
                }
            }
            questions.forEach { question ->
                val id = question["id"]?.string ?: return@forEach
                val text = question["questions"]?.array?.firstOrNull()?.get("text")?.string
                    ?: question["text"]?.string ?: renderValue(question)
                Text(text, fontSize = 12.sp)
                var answer by remember(id) { mutableStateOf("") }
                OutlinedTextField(value = answer, onValueChange = { answer = it }, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                remote.reply(
                                    RemoteMethod.QuestionReply,
                                    OperationKind.QuestionReply,
                                    JsonValue.obj(
                                        "requestID" to JsonValue.of(id),
                                        "answers" to JsonValue.Arr(
                                            listOf(JsonValue.Arr(listOf(JsonValue.of(answer)))),
                                        ),
                                    ),
                                )
                            }
                        },
                        enabled = answer.isNotBlank(),
                    ) { Text("回答") }
                    OutlinedButton(onClick = {
                        scope.launch {
                            remote.reply(
                                RemoteMethod.QuestionReply,
                                OperationKind.QuestionReply,
                                JsonValue.obj("requestID" to JsonValue.of(id), "reject" to JsonValue.of(true)),
                            )
                        }
                    }) { Text("跳过") }
                }
            }
        }
    }
}

private fun textOf(message: Map<String, JsonValue>): String =
    message["text"]?.string
        ?: message["prompt"]?.get("text")?.string
        ?: message["summary"]?.string
        ?: renderValue(JsonValue.Obj(message))

fun renderValue(value: JsonValue): String = when (value) {
    JsonValue.Null -> "null"
    is JsonValue.Bool -> value.value.toString()
    is JsonValue.Number -> value.token
    is JsonValue.Str -> value.value
    is JsonValue.Arr -> value.values.joinToString(", ", "[", "]") { renderValue(it) }
    is JsonValue.Obj -> value.entries.entries.joinToString(", ", "{", "}") { (key, item) -> "$key: ${renderValue(item)}" }
}

private fun renderDiff(value: JsonValue): String {
    val files = value["data"]?.array ?: value.array ?: return renderValue(value)
    return files.joinToString("\n") { file ->
        buildString {
            append(file["file"]?.string ?: file["path"]?.string ?: "变更")
            append("  +").append(file["additions"]?.long ?: 0)
            append(" -").append(file["deletions"]?.long ?: 0)
            file["diff"]?.string?.let { append('\n'); append(it) }
        }
    }
}

private fun Context.unused() = Unit
