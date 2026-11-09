package dev.miao.core

import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Minimal MCP client over the streamable HTTP transport: JSON-RPC 2.0 requests,
 * an optional `Mcp-Session-Id` from `initialize`, and responses that arrive as
 * either a JSON body or a `text/event-stream`. The phone has no stdio transport,
 * so a configured server must be reachable by URL.
 */
class McpClient(endpoint: String, private val client: OkHttpClient = shared) {
    data class Tool(val name: String, val description: String, val inputSchema: JsonValue)

    data class CallResult(val content: String, val isError: Boolean)

    private val url: String = endpoint.trim().let { if (it.endsWith("/")) it.dropLast(1) else it }
    private var sessionID: String? = null
    private var protocolVersion: String? = null
    private var nextID = 1

    init {
        val uri = try {
            java.net.URI(url)
        } catch (_: Exception) {
            throw McpException("MCP 地址无效")
        }
        if (uri.scheme != "https" && uri.scheme != "http") throw McpException("MCP 地址无效")
        if (uri.host.isNullOrEmpty()) throw McpException("MCP 地址无效")
    }

    suspend fun connect() {
        val result = request(
            "initialize",
            JsonValue.obj(
                "protocolVersion" to JsonValue.of(PROTOCOL_VERSION),
                "capabilities" to JsonValue.obj(),
                "clientInfo" to JsonValue.obj(
                    "name" to JsonValue.of("miao-android"),
                    "version" to JsonValue.of("1"),
                ),
            ),
        )
        protocolVersion = result["protocolVersion"]?.string ?: PROTOCOL_VERSION
        notify("notifications/initialized")
    }

    suspend fun tools(): List<Tool> {
        val result = request("tools/list", JsonValue.obj())
        val tools = result["tools"]?.array ?: throw McpException("MCP 服务返回了无法解析的工具列表")
        if (tools.size > 256) throw McpException("MCP 工具数量过多")
        return tools.mapNotNull { value ->
            val name = value["name"]?.string ?: return@mapNotNull null
            if (name.isEmpty() || name.length > 128) return@mapNotNull null
            Tool(
                name = name,
                description = value["description"]?.string ?: "",
                inputSchema = value["inputSchema"] ?: JsonValue.obj("type" to JsonValue.of("object")),
            )
        }
    }

    suspend fun callTool(name: String, arguments: JsonValue): CallResult {
        val result = request("tools/call", JsonValue.obj("name" to JsonValue.of(name), "arguments" to arguments))
        val content = result["content"]?.array ?: emptyList()
        val text = content.mapNotNull { item ->
            if (item["type"]?.string == "text") item["text"]?.string else null
        }.joinToString("\n")
        return CallResult(text.ifEmpty { "（无文本返回）" }, result["isError"]?.bool == true)
    }

    private suspend fun request(method: String, params: JsonValue): JsonValue {
        val id = synchronized(this) { nextID++ }
        val body = CanonicalJson.encodeBytes(
            JsonValue.obj(
                "jsonrpc" to JsonValue.of("2.0"),
                "id" to JsonValue.of(id),
                "method" to JsonValue.of(method),
                "params" to params,
            ),
        )
        val response = send(body)
        return readResult(response, id)
    }

    private suspend fun notify(method: String) {
        val body = CanonicalJson.encodeBytes(
            JsonValue.obj(
                "jsonrpc" to JsonValue.of("2.0"),
                "method" to JsonValue.of(method),
            ),
        )
        // The server may answer 202 with no body; a failure here is not fatal.
        runCatching { send(body).close() }
    }

    private suspend fun send(body: ByteArray): Response {
        val builder = Request.Builder()
            .url(url)
            .post(body.toRequestBody(JSON))
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
        sessionID?.let { builder.header("Mcp-Session-Id", it) }
        protocolVersion?.let { builder.header("MCP-Protocol-Version", it) }
        val response = try {
            withContext(Dispatchers.IO) { client.newCall(builder.build()).execute() }
        } catch (failure: java.io.IOException) {
            throw McpException("MCP 服务无法连接")
        }
        response.header("Mcp-Session-Id")?.let { if (it.length <= 256) sessionID = it }
        if (!response.isSuccessful) {
            response.close()
            throw McpException("MCP 服务返回 ${response.code}")
        }
        return response
    }

    private fun readResult(response: Response, id: Int): JsonValue {
        val contentType = response.header("Content-Type") ?: ""
        val message = if (contentType.contains("text/event-stream")) {
            readEvent(response, id)
        } else {
            val bytes = response.body?.bytes() ?: throw McpException("MCP 服务没有返回内容")
            if (bytes.size > MAX_BODY) throw McpException("MCP 响应过大")
            parse(bytes)
        }
        if (message["jsonrpc"]?.string != "2.0") throw McpException("MCP 响应格式无效")
        val error = message["error"]
        if (error != null && error != JsonValue.Null) {
            val text = error["message"]?.string ?: "调用失败"
            throw McpException("MCP：$text")
        }
        if (message["id"]?.long?.toInt() != id) throw McpException("MCP 响应与请求不匹配")
        return message["result"] ?: throw McpException("MCP 响应缺少结果")
    }

    /** Reads SSE frames until the response for [id] arrives, bounded by lines and bytes. */
    private fun readEvent(response: Response, id: Int): JsonValue {
        val reader = BufferedReader(InputStreamReader(response.body!!.byteStream(), Charsets.UTF_8))
        var lines = 0
        var bytes = 0
        reader.use {
            while (true) {
                val line = it.readLine() ?: throw McpException("MCP 事件流提前结束")
                lines++
                bytes += line.length
                if (lines > MAX_EVENTS || bytes > MAX_BODY) throw McpException("MCP 事件流过大")
                if (!line.startsWith("data:")) continue
                val payload = line.substring(5).trim()
                if (payload.isEmpty()) continue
                val message = try {
                    CanonicalJson.parse(payload)
                } catch (_: JsonParseException) {
                    continue
                }
                if (message["id"]?.long?.toInt() == id) return message
            }
            @Suppress("UNREACHABLE_CODE")
            throw McpException("MCP 事件流提前结束")
        }
    }

    private fun parse(bytes: ByteArray): JsonValue = try {
        CanonicalJson.parse(bytes)
    } catch (_: JsonParseException) {
        throw McpException("MCP 响应格式无效")
    }

    companion object {
        private const val PROTOCOL_VERSION = "2025-06-18"
        private const val MAX_BODY = 1024 * 1024
        private const val MAX_EVENTS = 512
        private val JSON = "application/json".toMediaType()

        private val shared: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .build()
        }
    }
}

class McpException(val text: String) : Exception(text)
