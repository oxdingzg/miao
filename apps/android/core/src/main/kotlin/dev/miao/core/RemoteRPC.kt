package dev.miao.core

import java.net.URL
import java.util.UUID

enum class RemoteMethod(val wire: String) {
    Capabilities("capabilities"),
    ProjectList("project.list"),
    SessionList("session.list"),
    SessionGet("session.get"),
    SessionHistory("session.history"),
    SessionEvents("session.events"),
    SessionPending("session.pending"),
    SessionDiff("session.diff"),
    SelectionList("selection.list"),
    OperationGet("operation.get"),
    SessionCreate("session.create"),
    SessionPrompt("session.prompt"),
    SessionInterrupt("session.interrupt"),
    SessionRename("session.rename"),
    SessionSwitchAgent("session.switchAgent"),
    SessionSwitchModel("session.switchModel"),
    PermissionReply("permission.reply"),
    QuestionReply("question.reply"),
    ProviderList("provider.list"),
    ProviderConnectKey("provider.connectKey"),
    ProviderDisconnect("provider.disconnect"),
    ModelDefault("model.default"),
    PendingList("pending.list"),
    SessionPin("session.pin"),
    SessionRemove("session.remove"),
    SessionArchive("session.archive"),
}

data class ApprovedHost(
    val id: UUID,
    val label: String,
    val hubURL: String,
    val target: RemoteTarget,
    val publicKey: String,
    val grantID: String,
    val grantVersion: Int,
) {
    companion object {
        fun create(
            label: String,
            hubURL: String,
            target: RemoteTarget,
            publicKey: String,
            grantID: String,
            grantVersion: Int,
            id: UUID = UUID.randomUUID(),
        ): ApprovedHost = ApprovedHost(id, label, hubURL, target, publicKey, grantID, grantVersion)
    }
}

sealed class RemoteRPCException(message: String) : Exception(message) {
    class InvalidEndpoint : RemoteRPCException("invalid endpoint")
    class Malformed : RemoteRPCException("malformed message")
    class Disconnected : RemoteRPCException("disconnected")
    class Timeout : RemoteRPCException("timeout")
    class Overloaded : RemoteRPCException("overloaded")
    class Rejected(val code: String) : RemoteRPCException("rejected: $code")
}

class AuthorizationBlockedException : Exception("authorization blocked")
class ProtocolIncompatibleException : Exception("protocol incompatible")

data class RemoteRequest(
    val requestID: String,
    val hostID: String,
    val runtimeID: String,
    val grantID: String,
    val grantVersion: Int,
    val method: RemoteMethod,
    val sessionID: String? = null,
    val projectID: String? = null,
    val operationID: String? = null,
    val payload: JsonValue = JsonValue.Obj(emptyMap()),
) {
    fun toJson(): JsonValue {
        val entries = linkedMapOf<String, JsonValue>(
            "version" to JsonValue.of(1),
            "requestID" to JsonValue.of(requestID),
            "hostID" to JsonValue.of(hostID),
            "runtimeID" to JsonValue.of(runtimeID),
            "grantID" to JsonValue.of(grantID),
            "grantVersion" to JsonValue.of(grantVersion),
            "method" to JsonValue.of(method.wire),
            "payload" to payload,
        )
        sessionID?.let { entries["sessionID"] = JsonValue.of(it) }
        projectID?.let { entries["projectID"] = JsonValue.of(it) }
        operationID?.let { entries["operationID"] = JsonValue.of(it) }
        return JsonValue.Obj(entries)
    }

    fun encode(): ByteArray = CanonicalJson.encodeBytes(toJson())
}

data class RemoteResponse(val version: Int, val type: String, val requestID: String, val data: JsonValue?, val code: String?) {
    companion object {
        fun fromJson(value: JsonValue): RemoteResponse {
            val version = value["version"]?.long?.toInt() ?: throw RemoteRPCException.Malformed()
            val type = value["type"]?.string ?: throw RemoteRPCException.Malformed()
            val requestID = value["requestID"]?.string ?: throw RemoteRPCException.Malformed()
            return RemoteResponse(version, type, requestID, value["data"], value["code"]?.string)
        }
    }
}

/** Only complete, ordered transfers are returned to the state reducer. */
class ResponseAssembler(private val allowedTypes: Set<String> = setOf("result", "error")) {
    private var transferID: String? = null
    private var total = 0
    private var next = 0
    private val bytes = java.io.ByteArrayOutputStream()

    private fun reset() {
        transferID = null
        total = 0
        next = 0
        bytes.reset()
    }

    fun append(packet: ByteArray): ByteArray? {
        if (packet.size > 128 * 1024) throw RemoteRPCException.Malformed()
        val value = try {
            CanonicalJson.parse(packet)
        } catch (_: JsonParseException) {
            throw RemoteRPCException.Malformed()
        }
        if (value["version"]?.long != 1L) throw RemoteRPCException.Malformed()
        val type = value["type"]?.string ?: throw RemoteRPCException.Malformed()
        if (type != "chunk") {
            if (transferID != null || type !in allowedTypes) throw RemoteRPCException.Malformed()
            return packet
        }
        val chunkTransfer = value["transferID"]?.string ?: throw RemoteRPCException.Malformed()
        val chunkTotal = value["total"]?.long ?: throw RemoteRPCException.Malformed()
        val index = value["index"]?.long ?: throw RemoteRPCException.Malformed()
        val payload = value["payload"]?.string ?: throw RemoteRPCException.Malformed()
        if (runCatching { UUID.fromString(chunkTransfer) }.isFailure) throw RemoteRPCException.Malformed()
        if (chunkTotal <= 0 || chunkTotal > 128 || index < 0 || index >= chunkTotal) throw RemoteRPCException.Malformed()
        if (transferID == null) {
            if (index != 0L) throw RemoteRPCException.Malformed()
            transferID = chunkTransfer
            total = chunkTotal.toInt()
        }
        if (chunkTransfer != transferID || chunkTotal != total.toLong() || index != next.toLong()) {
            throw RemoteRPCException.Malformed()
        }
        if (payload.length > 88 * 1024) throw RemoteRPCException.Malformed()
        val decoded = BinaryEncoding.decodeOrNull(payload, null) ?: throw RemoteRPCException.Malformed()
        if (decoded.size > 64 * 1024 || bytes.size() + decoded.size > 8 * 1024 * 1024) throw RemoteRPCException.Malformed()
        bytes.write(decoded)
        next += 1
        if (next != total) return null
        val complete = bytes.toByteArray()
        reset()
        return complete
    }
}

/** The endpoint is the Hub's `/v1/client` WebSocket with a pinned host identity. */
fun clientEndpoint(hubURL: URL, hostID: String, allowLoopbackHTTP: Boolean, runtimeID: String? = null): String {
    val scheme = hubURL.protocol.lowercase()
    val host = hubURL.host.lowercase()
    val local = allowLoopbackHTTP && scheme == "http" &&
        host in setOf("localhost", "127.0.0.1", "::1", "[::1]")
    if (scheme != "https" && !local) throw RemoteRPCException.InvalidEndpoint()
    if (hubURL.userInfo != null || hubURL.query != null || hubURL.ref != null) throw RemoteRPCException.InvalidEndpoint()
    if (hubURL.path.isNotEmpty() && hubURL.path != "/") throw RemoteRPCException.InvalidEndpoint()
    if (host.isEmpty()) throw RemoteRPCException.InvalidEndpoint()
    val websocketScheme = if (local) "ws" else "wss"
    val port = if (hubURL.port == -1) "" else ":" + hubURL.port
    val runtime = runtimeID?.let {
        RemoteTarget(hostID, it).validate()
        "&runtimeID=" + java.net.URLEncoder.encode(it, "UTF-8")
    } ?: ""
    return "$websocketScheme://$host$port/v1/client?hostID=${java.net.URLEncoder.encode(hostID, "UTF-8")}$runtime"
}
