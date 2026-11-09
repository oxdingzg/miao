package dev.miao.core

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class McpTest {
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val seen = mutableListOf<Pair<String, String?>>()

    private fun start(handler: (String, JsonValue, HttpExchange) -> Unit) {
        server.createContext("/mcp") { exchange ->
            val body = exchange.requestBody.readBytes()
            val message = CanonicalJson.parse(body)
            val method = message["method"]?.string ?: ""
            seen += method to exchange.requestHeaders.getFirst("Mcp-Session-Id")
            handler(method, message, exchange)
        }
        server.start()
    }

    private fun respond(exchange: HttpExchange, body: ByteArray, contentType: String = "application/json", code: Int = 200) {
        exchange.responseHeaders.add("Content-Type", contentType)
        exchange.sendResponseHeaders(code, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
    }

    private fun result(exchange: HttpExchange, message: JsonValue, result: JsonValue) {
        respond(
            exchange,
            CanonicalJson.encodeBytes(
                JsonValue.obj(
                    "jsonrpc" to JsonValue.of("2.0"),
                    "id" to (message["id"] ?: JsonValue.Null),
                    "result" to result,
                ),
            ),
        )
    }

    private fun url(): String = "http://127.0.0.1:${server.address.port}/mcp"

    @AfterTest
    fun stop() {
        server.stop(0)
    }

    @Test
    fun handshakeListsAndCallsToolsOverJsonAndEvents() = runBlocking {
        start { method, message, exchange ->
            when (method) {
                "initialize" -> {
                    exchange.responseHeaders.add("Mcp-Session-Id", "session-123")
                    result(
                        exchange,
                        message,
                        JsonValue.obj(
                            "protocolVersion" to JsonValue.of("2025-03-26"),
                            "capabilities" to JsonValue.obj(),
                            "serverInfo" to JsonValue.obj("name" to JsonValue.of("fixture"), "version" to JsonValue.of("1")),
                        ),
                    )
                }
                "notifications/initialized" -> respond(exchange, ByteArray(0), code = 202)
                "tools/list" -> result(
                    exchange,
                    message,
                    JsonValue.obj(
                        "tools" to JsonValue.Arr(
                            listOf(
                                JsonValue.obj(
                                    "name" to JsonValue.of("echo"),
                                    "description" to JsonValue.of("Echo text"),
                                    "inputSchema" to JsonValue.obj(
                                        "type" to JsonValue.of("object"),
                                        "properties" to JsonValue.obj("text" to JsonValue.obj("type" to JsonValue.of("string"))),
                                    ),
                                ),
                            ),
                        ),
                    ),
                )
                "tools/call" -> {
                    val id = message["id"]
                    val payload = CanonicalJson.encode(
                        JsonValue.obj(
                            "jsonrpc" to JsonValue.of("2.0"),
                            "id" to (id ?: JsonValue.Null),
                            "result" to JsonValue.obj(
                                "content" to JsonValue.Arr(
                                    listOf(JsonValue.obj("type" to JsonValue.of("text"), "text" to JsonValue.of("pong"))),
                                ),
                            ),
                        ),
                    )
                    respond(exchange, "event: message\ndata: $payload\n\n".toByteArray(), contentType = "text/event-stream")
                }
                else -> respond(exchange, ByteArray(0), code = 404)
            }
        }

        val client = McpClient(url())
        client.connect()
        val tools = client.tools()
        assertEquals(listOf("echo"), tools.map { it.name })
        assertEquals("Echo text", tools.single().description)

        val call = client.callTool("echo", JsonValue.obj("text" to JsonValue.of("ping")))
        assertEquals("pong", call.content)
        assertTrue(!call.isError)

        // The session id must reach every request after `initialize`.
        assertEquals(
            listOf(
                "initialize" to null,
                "notifications/initialized" to "session-123",
                "tools/list" to "session-123",
                "tools/call" to "session-123",
            ),
            seen,
        )
    }

    @Test
    fun jsonRpcErrorBecomesAMcpException() = runBlocking {
        start { method, message, exchange ->
            if (method == "initialize") {
                result(exchange, message, JsonValue.obj("protocolVersion" to JsonValue.of("2025-06-18")))
                return@start
            }
            respond(
                exchange,
                CanonicalJson.encodeBytes(
                    JsonValue.obj(
                        "jsonrpc" to JsonValue.of("2.0"),
                        "id" to (message["id"] ?: JsonValue.Null),
                        "error" to JsonValue.obj("code" to JsonValue.of(-32601), "message" to JsonValue.of("Unknown tool")),
                    ),
                ),
            )
        }
        val client = McpClient(url())
        client.connect()
        val failure = assertFailsWith<McpException> { client.tools() }
        assertTrue(failure.text.contains("Unknown tool"))
    }

    @Test
    fun mismatchedAndMalformedResponsesAreRejected() {
        runBlocking {
        start { method, message, exchange ->
            when (method) {
                "initialize" -> result(exchange, message, JsonValue.obj("protocolVersion" to JsonValue.of("2025-06-18")))
                "tools/list" -> respond(
                    exchange,
                    CanonicalJson.encodeBytes(
                        JsonValue.obj(
                            "jsonrpc" to JsonValue.of("2.0"),
                            "id" to JsonValue.of(999),
                            "result" to JsonValue.obj(),
                        ),
                    ),
                )
                else -> respond(exchange, ByteArray(0), code = 202)
            }
        }
            val client = McpClient(url())
            client.connect()
            assertFailsWith<McpException> { client.tools() }
        }
    }

    @Test
    fun invalidEndpointsAreRejectedBeforeAnyRequest() {
        assertFailsWith<McpException> { McpClient("ftp://example.invalid") }
        assertFailsWith<McpException> { McpClient("not a url") }
    }

    @Test
    fun eventStreamWithoutTheMatchingIdFails() {
        runBlocking {
        start { method, message, exchange ->
            when (method) {
                "initialize" -> result(exchange, message, JsonValue.obj("protocolVersion" to JsonValue.of("2025-06-18")))
                "tools/list" -> respond(
                    exchange,
                    "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":42,\"result\":{}}\n\n".toByteArray(),
                    contentType = "text/event-stream",
                )
                else -> respond(exchange, ByteArray(0), code = 202)
            }
        }
            val client = McpClient(url())
            client.connect()
            assertFailsWith<McpException> { client.tools() }
        }
    }
}
