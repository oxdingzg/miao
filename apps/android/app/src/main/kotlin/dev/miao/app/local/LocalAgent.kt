package dev.miao.app.local

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.miao.core.CanonicalJson
import dev.miao.core.JsonParseException
import dev.miao.core.JsonValue
import dev.miao.core.McpClient
import dev.miao.core.McpException
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class LocalAgentException(val text: String) : Exception(text)

data class LocalApproval(val tool: String, val detail: String)

/**
 * On-device assistant: it talks to a provider the owner configured on the phone
 * and runs its tools against the app's own sandbox. No computer, account or
 * relay is involved.
 */
class LocalAgent(context: Context, private val scope: CoroutineScope) {
    var providers by mutableStateOf<List<LocalProvider>>(emptyList())
        private set
    var selectedID by mutableStateOf<String?>(null)
        private set
    var sessions by mutableStateOf<List<LocalSession>>(emptyList())
        private set
    var currentID by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    var approval by mutableStateOf<LocalApproval?>(null)
        private set
    var autoAllowTools by mutableStateOf(false)
    var mcpURL by mutableStateOf<String?>(null)
        private set
    var mcpTools by mutableStateOf<List<McpClient.Tool>>(emptyList())
        private set
    var mcpError by mutableStateOf<String?>(null)
        private set

    val workspace: File = File(context.filesDir, "LocalAgent/workspace")
    private val configFile = File(context.filesDir, "LocalAgent/config.json")
    private val sessionsFile = File(context.filesDir, "LocalAgent/sessions.json")
    private var task: Job? = null
    private var decision: CompletableDeferred<Boolean>? = null
    private var call: Call? = null
    private var mcp: McpClient? = null

    init {
        workspace.mkdirs()
        load()
    }

    val provider: LocalProvider
        get() = providers.firstOrNull { it.id == selectedID } ?: LocalProvider()

    val ready: Boolean get() = provider.ready

    val messages: List<LocalMessage>
        get() = sessions.firstOrNull { it.id == currentID }?.messages ?: emptyList()

    fun save(next: LocalProvider) {
        providers = if (providers.any { it.id == next.id }) {
            providers.map { if (it.id == next.id) next else it }
        } else {
            providers + next
        }
        if (selectedID == null) selectedID = next.id
        storeConfig()
    }

    fun select(id: String?) {
        selectedID = id
        storeConfig()
    }

    fun remove(id: String) {
        providers = providers.filterNot { it.id == id }
        if (selectedID == id) selectedID = providers.firstOrNull()?.id
        storeConfig()
    }

    fun setMcp(raw: String) {
        val trimmed = raw.trim()
        mcpURL = trimmed.ifEmpty { null }
        mcp = null
        mcpTools = emptyList()
        mcpError = null
        storeConfig()
        scope.launch { refreshMcp() }
    }

    suspend fun refreshMcp() {
        val raw = mcpURL ?: return
        mcpError = null
        try {
            val client = McpClient(raw)
            client.connect()
            mcpTools = client.tools()
            mcp = client
        } catch (failure: Throwable) {
            mcpTools = emptyList()
            mcp = null
            mcpError = if (failure is McpException) failure.text else "MCP 连接失败"
        }
    }

    fun newSession() {
        stop()
        val session = LocalSession()
        sessions = listOf(session) + sessions
        currentID = session.id
        persist()
    }

    fun selectSession(id: String) {
        if (sessions.none { it.id == id }) return
        stop()
        currentID = id
    }

    fun renameSession(id: String, title: String) {
        sessions = sessions.map { if (it.id == id) it.copy(title = title.trim()) else it }
        persist()
    }

    fun deleteSession(id: String) {
        sessions = sessions.filterNot { it.id == id }
        if (currentID == id) currentID = sessions.firstOrNull()?.id
        if (sessions.isEmpty()) newSession() else persist()
    }

    fun clear() {
        stop()
        updateMessages { it.clear() }
        sessions = sessions.map { if (it.id == currentID) it.copy(title = "") else it }
        persist()
    }

    fun send(text: String) {
        val prompt = text.trim()
        if (prompt.isEmpty() || busy || !ready) return
        error = null
        updateMessages { it.add(LocalMessage(role = LocalMessage.Role.User, text = prompt)) }
        persist()
        startTurn()
    }

    /** Drops the answer and its tool traffic, then runs the last prompt again. */
    fun retryLast() {
        if (busy || !ready) return
        val session = sessions.firstOrNull { it.id == currentID } ?: return
        val list = session.messages.toMutableList()
        while (list.isNotEmpty() && list.last().role != LocalMessage.Role.User) list.removeAt(list.size - 1)
        if (list.none { it.role == LocalMessage.Role.User }) return
        replaceMessages(list)
        persist()
        error = null
        startTurn()
    }

    /** Rewinds to just before [messageID] and returns the text to put back in the composer. */
    fun rewind(before: String): String? {
        if (busy) return null
        val session = sessions.firstOrNull { it.id == currentID } ?: return null
        val position = session.messages.indexOfFirst { it.id == before }
        if (position < 0) return null
        val text = session.messages[position].text
        replaceMessages(session.messages.subList(0, position).toMutableList())
        persist()
        return text
    }

    fun stop() {
        decision?.complete(false)
        decision = null
        approval = null
        task?.cancel()
        task = null
        call?.cancel()
        call = null
        busy = false
    }

    /** Denying reports back to the model as a tool failure instead of silently skipping it. */
    fun resolve(approved: Boolean) {
        approval = null
        decision?.complete(approved)
        decision = null
    }

    private fun startTurn() {
        busy = true
        task = scope.launch {
            try {
                run()
            } finally {
                busy = false
            }
        }
    }

    private suspend fun run() {
        // Bounded so a model that keeps asking for tools cannot spin forever.
        repeat(8) {
            if (!busy) return
            val reply = try {
                complete()
            } catch (failure: Throwable) {
                error = message(failure)
                return
            }
            val tool = reply.tool
            if (tool == null) {
                if (!reply.streamed) {
                    updateMessages { it.add(LocalMessage(role = LocalMessage.Role.Assistant, text = reply.text)) }
                }
                persist()
                return
            }
            perform(tool)
        }
        updateMessages {
            it.add(LocalMessage(role = LocalMessage.Role.Assistant, text = "（工具调用次数达到上限，先停在这里）"))
        }
        persist()
    }

    private data class ToolCall(val id: String, val name: String, val arguments: String)

    private data class Reply(val text: String, val tool: ToolCall?, val streamed: Boolean)

    private suspend fun complete(): Reply = withContext(Dispatchers.IO) {
        val current = provider
        val endpoint = endpoint(current)
        val body = CanonicalJson.encodeBytes(
            JsonValue.obj(
                "model" to JsonValue.of(current.model),
                "messages" to JsonValue.Arr(wireMessages()),
                "tools" to JsonValue.Arr(toolDefinitions()),
                "stream" to JsonValue.of(true),
            ),
        )
        val request = Request.Builder()
            .url(endpoint)
            .post(body.toRequestBody("application/json".toMediaType()))
            .header("Authorization", "Bearer " + current.apiKey)
            .header("Content-Type", "application/json")
            .build()
        val active = client.newCall(request)
        call = active
        var text = ""
        var callID: String? = null
        var callName: String? = null
        val callArguments = StringBuilder()
        var streamed = false
        try {
            active.execute().use { response ->
                if (!response.isSuccessful) {
                    val preview = response.body?.bytes()?.take(400)?.toByteArray()?.toString(Charsets.UTF_8) ?: ""
                    throw LocalAgentException("服务商返回 ${response.code}：$preview")
                }
                val source = response.body?.source() ?: throw LocalAgentException("模型返回了无法解析的内容")
                while (!source.exhausted()) {
                    if (!busy) break
                    val line = source.readUtf8Line() ?: break
                    if (!line.startsWith("data:")) continue
                    val payload = line.substring(5).trim()
                    if (payload == "[DONE]") break
                    val value = try {
                        CanonicalJson.parse(payload)
                    } catch (_: JsonParseException) {
                        continue
                    }
                    val delta = value["choices"]?.array?.firstOrNull()?.get("delta") ?: continue
                    val piece = delta["content"]?.string
                    if (!piece.isNullOrEmpty()) {
                        text += piece
                        if (streamed) {
                            updateMessages { list ->
                                if (list.isNotEmpty() && list.last().role == LocalMessage.Role.Assistant) {
                                    list[list.size - 1] = list.last().copy(text = text)
                                }
                            }
                        } else {
                            updateMessages { it.add(LocalMessage(role = LocalMessage.Role.Assistant, text = text)) }
                            streamed = true
                        }
                    }
                    val deltaCall = delta["tool_calls"]?.array?.firstOrNull()
                    if (deltaCall != null) {
                        deltaCall["id"]?.string?.let { callID = it }
                        val function = deltaCall["function"]
                        function?.get("name")?.string?.let { callName = it }
                        function?.get("arguments")?.string?.let { callArguments.append(it) }
                    }
                }
            }
        } finally {
            call = null
        }
        if (callName != null && text.isEmpty() && streamed) {
            // A turn that only calls a tool must not leave an empty bubble behind.
            updateMessages { if (it.isNotEmpty() && it.last().role == LocalMessage.Role.Assistant) it.removeAt(it.size - 1) }
            streamed = false
        }
        val name = callName
        return@withContext when {
            name != null -> Reply(
                text = text,
                tool = ToolCall(
                    id = callID ?: UUID.randomUUID().toString(),
                    name = name,
                    arguments = callArguments.toString().ifEmpty { "{}" },
                ),
                streamed = streamed,
            )
            else -> Reply(text.ifEmpty { "（模型没有返回内容）" }, null, streamed)
        }
    }

    private fun endpoint(provider: LocalProvider): String {
        val trimmed = provider.baseURL.trim()
        if (trimmed.isEmpty()) throw LocalAgentException("接口地址无效")
        val base = if (trimmed.endsWith("/")) trimmed.dropLast(1) else trimmed
        return if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
    }

    private fun wireMessages(): List<JsonValue> {
        val wire = mutableListOf<JsonValue>(
            JsonValue.obj("role" to JsonValue.of("system"), "content" to JsonValue.of(SYSTEM_PROMPT)),
        )
        for (message in messages) {
            when (message.role) {
                LocalMessage.Role.User -> {
                    if (message.images.isEmpty()) {
                        wire += JsonValue.obj("role" to JsonValue.of("user"), "content" to JsonValue.of(message.text))
                    } else {
                        val parts = mutableListOf<JsonValue>(
                            JsonValue.obj("type" to JsonValue.of("text"), "text" to JsonValue.of(message.text)),
                        )
                        for (image in message.images) {
                            parts += JsonValue.obj(
                                "type" to JsonValue.of("image_url"),
                                "image_url" to JsonValue.obj("url" to JsonValue.of("data:image/jpeg;base64,$image")),
                            )
                        }
                        wire += JsonValue.obj("role" to JsonValue.of("user"), "content" to JsonValue.Arr(parts))
                    }
                }
                LocalMessage.Role.Assistant ->
                    wire += JsonValue.obj("role" to JsonValue.of("assistant"), "content" to JsonValue.of(message.text))
                LocalMessage.Role.Tool ->
                    wire += JsonValue.obj(
                        "role" to JsonValue.of("user"),
                        "content" to JsonValue.of("[${message.toolName ?: "tool"}] ${message.text}"),
                    )
            }
        }
        return wire
    }

    private fun toolDefinitions(): List<JsonValue> = listOf(
        tool("list_files", "List files under a workspace directory", listOf("path")),
        tool("read_file", "Read a UTF-8 text file from the workspace", listOf("path")),
        tool("write_file", "Write a UTF-8 text file in the workspace", listOf("path", "content")),
        tool("fetch_url", "Fetch an HTTP(S) URL and return its text", listOf("url")),
    ) + mcpTools.map { definition ->
        JsonValue.obj(
            "type" to JsonValue.of("function"),
            "function" to JsonValue.obj(
                "name" to JsonValue.of(definition.name),
                "description" to JsonValue.of(definition.description),
                "parameters" to definition.inputSchema,
            ),
        )
    }

    private fun tool(name: String, description: String, parameters: List<String>): JsonValue = JsonValue.obj(
        "type" to JsonValue.of("function"),
        "function" to JsonValue.obj(
            "name" to JsonValue.of(name),
            "description" to JsonValue.of(description),
            "parameters" to JsonValue.obj(
                "type" to JsonValue.of("object"),
                "properties" to JsonValue.obj(*parameters.map { it to JsonValue.obj("type" to JsonValue.of("string")) }.toTypedArray()),
                "required" to JsonValue.Arr(parameters.map { JsonValue.of(it) }),
            ),
        ),
    )

    private suspend fun allowed(call: ToolCall): Boolean {
        if (autoAllowTools) return true
        // Reading the workspace needs no gate; writing it and reaching the network do.
        if (call.name == "list_files" || call.name == "read_file") return true
        val deferred = CompletableDeferred<Boolean>()
        decision = deferred
        approval = LocalApproval(call.name, call.arguments)
        return deferred.await()
    }

    private suspend fun perform(call: ToolCall) {
        updateMessages { it.add(LocalMessage(role = LocalMessage.Role.Tool, text = "调用 ${call.name}", toolName = call.name)) }
        persist()
        val arguments = try {
            CanonicalJson.parse(call.arguments).objectMap ?: emptyMap()
        } catch (_: JsonParseException) {
            emptyMap()
        }
        val result = try {
            if (!allowed(call)) {
                "用户拒绝了这次操作。"
            } else {
                if (mcpTools.any { it.name == call.name }) {
                    callMcp(call)
                } else {
                    when (call.name) {
                        "list_files" -> list(arguments["path"]?.string ?: ".")
                        "read_file" -> read(arguments["path"]?.string ?: "")
                        "write_file" -> write(arguments["path"]?.string ?: "", arguments["content"]?.string ?: "")
                        "fetch_url" -> fetch(arguments["url"]?.string ?: "")
                        else -> "未知工具：${call.name}"
                    }
                }
            }
        } catch (failure: Throwable) {
            "失败：${message(failure)}"
        }
        updateMessages { it.add(LocalMessage(role = LocalMessage.Role.Tool, text = result, toolName = call.name)) }
        persist()
    }

    private fun resolve(path: String): File {
        val candidate = if (path.isEmpty() || path == ".") workspace else File(workspace, path)
        // Symlinks and `..` must not escape the workspace.
        val base = workspace.canonicalPath
        val target = candidate.canonicalPath
        if (target != base && !target.startsWith(base + File.separator)) {
            throw LocalAgentException("路径超出了本机工作区")
        }
        return File(target)
    }

    private fun list(path: String): String {
        val entries = resolve(path).list()?.sorted() ?: emptyList()
        return entries.ifEmpty { listOf("（空目录）") }.joinToString("\n")
    }

    private fun read(path: String): String {
        val file = resolve(path)
        if (!file.isFile) throw LocalAgentException("文件不存在")
        val bytes = file.inputStream().use { it.readNBytes(200_000) }
        val text = String(bytes, Charsets.UTF_8)
        return text.ifEmpty { "（空文件）" }
    }

    private fun write(path: String, content: String): String {
        val file = resolve(path)
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, ".write-" + UUID.randomUUID())
        temporary.writeText(content)
        if (!temporary.renameTo(file)) {
            file.delete()
            if (!temporary.renameTo(file)) throw LocalAgentException("写入失败")
        }
        return "已写入 ${file.name}（${content.toByteArray().size} 字节）"
    }

    private suspend fun callMcp(call: ToolCall): String {
        val client = mcp ?: return "MCP 未连接"
        val arguments = try {
            CanonicalJson.parse(call.arguments)
        } catch (_: JsonParseException) {
            JsonValue.obj()
        }
        val result = client.callTool(call.name, arguments)
        return if (result.isError) "失败：${result.content}" else result.content
    }

    private fun fetch(value: String): String = java.net.URI(value).let { uri ->
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") throw LocalAgentException("接口地址无效")
        val request = Request.Builder().url(value).get().build()
        val active = client.newCall(request)
        call = active
        try {
            active.execute().use { response ->
                val bytes = response.body?.bytes()?.take(20_000)?.toByteArray() ?: ByteArray(0)
                "HTTP ${response.code}\n${String(bytes, Charsets.UTF_8)}"
            }
        } finally {
            call = null
        }
    }

    private fun message(failure: Throwable): String =
        if (failure is LocalAgentException) failure.text else failure.message ?: "本机助手暂时不可用"

    private fun updateMessages(transform: (MutableList<LocalMessage>) -> Unit) {
        val session = sessions.firstOrNull { it.id == currentID } ?: return
        val list = session.messages.toMutableList()
        transform(list)
        replaceMessages(list)
    }

    private fun replaceMessages(list: MutableList<LocalMessage>) {
        sessions = sessions.map { session ->
            if (session.id != currentID) return@map session
            val title = session.title.ifEmpty {
                list.firstOrNull { it.role == LocalMessage.Role.User }?.text?.take(30) ?: ""
            }
            session.copy(messages = list.toList(), title = title, updated = System.currentTimeMillis())
        }
    }

    private fun load() {
        val config = readJson(configFile)
        if (config != null) {
            providers = (config["providers"]?.array ?: emptyList()).map { LocalProvider.fromJson(it) }
            selectedID = config["selected"]?.string
            mcpURL = config["mcp"]?.string
        }
        if (selectedID == null) selectedID = providers.firstOrNull()?.id
        val history = readJson(sessionsFile)
        if (history != null) {
            sessions = (history.array ?: emptyList()).mapNotNull { LocalSession.fromJson(it) }
        }
        currentID = sessions.firstOrNull()?.id
        if (sessions.isEmpty()) newSession()
        if (mcpURL != null) scope.launch { refreshMcp() }
    }

    private fun readJson(file: File): JsonValue? {
        if (!file.isFile) return null
        return try {
            CanonicalJson.parse(file.readBytes())
        } catch (_: Exception) {
            null
        }
    }

    private fun storeConfig() {
        val bytes = CanonicalJson.encodeBytes(
            JsonValue.obj(
                "providers" to JsonValue.Arr(providers.map { it.toJson() }),
                "selected" to (selectedID?.let { JsonValue.of(it) } ?: JsonValue.Null),
                "mcp" to (mcpURL?.let { JsonValue.of(it) } ?: JsonValue.Null),
            ),
        )
        writeAtomic(configFile, bytes)
    }

    private fun persist() {
        writeAtomic(sessionsFile, LocalSession.listJson(sessions))
    }

    private fun writeAtomic(file: File, bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, ".${file.name}-" + UUID.randomUUID())
        temporary.writeBytes(bytes)
        if (!temporary.renameTo(file)) {
            file.delete()
            if (!temporary.renameTo(file)) throw LocalAgentException("保存失败")
        }
    }

    companion object {
        private const val SYSTEM_PROMPT =
            "You are miao running inside the user's phone. You can read, list and write files in your " +
                "workspace and fetch a URL. Paths are relative to the workspace. Be concise. When you change " +
                "a file, say which file you changed."

        private val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()
        }
    }
}
