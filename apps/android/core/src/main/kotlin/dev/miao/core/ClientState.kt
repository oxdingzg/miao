package dev.miao.core

import java.util.UUID

class ClientStateException(val reason: Reason) : Exception(reason.name) {
    enum class Reason {
        SCOPE_MISMATCH,
        INCOMPATIBLE_CHECKPOINT,
        LIMIT_EXCEEDED,
        OPERATION_CONFLICT,
        OPERATION_MISSING,
        INVALID_TRANSITION,
        STALE_CURSOR,
        INVALID_STORAGE,
    }
}

data class SessionAddress(val hostID: String, val runtimeID: String, val sessionID: String)

/** One cache partition per local device identity and Agent-issued grant. */
data class AuthorizationScope(val deviceID: String, val grantID: String, val hostID: String)

enum class OperationKind(val wire: String) {
    Prompt("prompt"),
    SessionCreate("sessionCreate"),
    PermissionReply("permissionReply"),
    QuestionReply("questionReply"),
    Interrupt("interrupt"),
    SessionRename("sessionRename"),
    SessionSwitchAgent("sessionSwitchAgent"),
    SessionSwitchModel("sessionSwitchModel"),
    SessionPin("sessionPin"),
    SessionRemove("sessionRemove"),
    SessionArchive("sessionArchive"),
    ;

    companion object {
        fun fromWire(value: String): OperationKind? = entries.firstOrNull { it.wire == value }
    }
}

enum class OperationStatus(val wire: String) {
    Prepared("prepared"),
    AwaitingConfirmation("awaitingConfirmation"),
    Accepted("accepted"),
    Completed("completed"),
    Rejected("rejected"),
    OutcomeUnknown("outcomeUnknown"),
    Expired("expired"),
    ;

    companion object {
        fun fromWire(value: String): OperationStatus? = entries.firstOrNull { it.wire == value }

        fun fromWireStatus(value: String?): OperationStatus? = when (value) {
            "accepted" -> Accepted
            "completed" -> Completed
            "rejected" -> Rejected
            "outcome_unknown" -> OutcomeUnknown
            else -> null
        }
    }
}

data class OperationTarget(val hostID: String, val runtimeID: String, val sessionID: String?, val projectID: String?) {
    init {
        if (sessionID.isNullOrEmpty() && projectID.isNullOrEmpty()) throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
    }

    companion object {
        fun of(session: SessionAddress): OperationTarget = OperationTarget(session.hostID, session.runtimeID, session.sessionID, null)
        fun ofProject(hostID: String, runtimeID: String, projectID: String): OperationTarget =
            OperationTarget(hostID, runtimeID, null, projectID)
    }
}

data class PendingOperation(
    val id: UUID,
    val scope: AuthorizationScope,
    val target: OperationTarget,
    val kind: OperationKind,
    val payload: ByteArray,
    val createdAt: Long,
    var status: OperationStatus = OperationStatus.Prepared,
    var result: ByteArray? = null,
) {
    init {
        if (status != OperationStatus.Prepared) throw ClientStateException(ClientStateException.Reason.INVALID_TRANSITION)
    }

    fun transition(next: OperationStatus, result: ByteArray?) {
        val terminal = setOf(OperationStatus.Completed, OperationStatus.Rejected, OperationStatus.Expired)
        if (!terminal.contains(status) || status == next) {
            if (status == OperationStatus.Accepted && next != OperationStatus.Accepted && next != OperationStatus.Completed) {
                throw ClientStateException(ClientStateException.Reason.INVALID_TRANSITION)
            }
            if (next == OperationStatus.Prepared) throw ClientStateException(ClientStateException.Reason.INVALID_TRANSITION)
            status = next
            this.result = result ?: this.result
            return
        }
        throw ClientStateException(ClientStateException.Reason.INVALID_TRANSITION)
    }
}

data class SessionCheckpoint(
    val address: SessionAddress,
    val state: ByteArray,
    val cursor: Long,
    val updatedAt: Long,
)

data class Draft(val address: SessionAddress, val text: String)

data class ClientCheckpoint(
    val version: Int = 1,
    val scope: AuthorizationScope,
    val operations: List<PendingOperation> = emptyList(),
    val sessions: List<SessionCheckpoint> = emptyList(),
    val drafts: List<Draft> = emptyList(),
) {
    fun validate() {
        if (version != 1) throw ClientStateException(ClientStateException.Reason.INCOMPATIBLE_CHECKPOINT)
        if (
            operations.size > 1024 || sessions.size > 256 || drafts.size > 256 ||
            operations.map { it.id }.toSet().size != operations.size ||
            sessions.map { it.address }.toSet().size != sessions.size ||
            drafts.map { it.address }.toSet().size != drafts.size
        ) {
            throw ClientStateException(ClientStateException.Reason.LIMIT_EXCEEDED)
        }
        if (
            operations.any { it.scope != scope || it.target.hostID != scope.hostID } ||
            sessions.any { it.address.hostID != scope.hostID || it.cursor < 0 } ||
            drafts.any { it.address.hostID != scope.hostID }
        ) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
    }
}

internal object CheckpointCodec {
    fun encode(checkpoint: ClientCheckpoint): ByteArray = CanonicalJson.encodeBytes(
        JsonValue.obj(
            "version" to JsonValue.of(checkpoint.version),
            "scope" to scopeJson(checkpoint.scope),
            "operations" to JsonValue.Arr(checkpoint.operations.map(::operationJson)),
            "sessions" to JsonValue.Arr(checkpoint.sessions.map(::sessionJson)),
            "drafts" to JsonValue.Arr(checkpoint.drafts.map(::draftJson)),
        ),
    )

    fun decode(bytes: ByteArray): ClientCheckpoint {
        val value = try {
            CanonicalJson.parse(bytes)
        } catch (_: JsonParseException) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        val scope = readScope(value["scope"])
        val operations = (value["operations"]?.array ?: throw invalid()).map(::readOperation)
        val sessions = (value["sessions"]?.array ?: throw invalid()).map(::readSession)
        val drafts = (value["drafts"]?.array ?: throw invalid()).map(::readDraft)
        val checkpoint = ClientCheckpoint(
            version = value["version"]?.long?.toInt() ?: throw invalid(),
            scope = scope,
            operations = operations,
            sessions = sessions,
            drafts = drafts,
        )
        checkpoint.validate()
        return checkpoint
    }

    private fun scopeJson(scope: AuthorizationScope): JsonValue = JsonValue.obj(
        "deviceID" to JsonValue.of(scope.deviceID),
        "grantID" to JsonValue.of(scope.grantID),
        "hostID" to JsonValue.of(scope.hostID),
    )

    private fun readScope(value: JsonValue?): AuthorizationScope = AuthorizationScope(
        deviceID = value?.get("deviceID")?.string ?: throw invalid(),
        grantID = value?.get("grantID")?.string ?: throw invalid(),
        hostID = value?.get("hostID")?.string ?: throw invalid(),
    )

    private fun addressJson(address: SessionAddress): JsonValue = JsonValue.obj(
        "hostID" to JsonValue.of(address.hostID),
        "runtimeID" to JsonValue.of(address.runtimeID),
        "sessionID" to JsonValue.of(address.sessionID),
    )

    private fun readAddress(value: JsonValue?): SessionAddress = SessionAddress(
        hostID = value?.get("hostID")?.string ?: throw invalid(),
        runtimeID = value?.get("runtimeID")?.string ?: throw invalid(),
        sessionID = value?.get("sessionID")?.string ?: throw invalid(),
    )

    private fun operationJson(operation: PendingOperation): JsonValue = JsonValue.obj(
        "id" to JsonValue.of(operation.id.toString()),
        "scope" to scopeJson(operation.scope),
        "target" to JsonValue.obj(
            "hostID" to JsonValue.of(operation.target.hostID),
            "runtimeID" to JsonValue.of(operation.target.runtimeID),
            "sessionID" to (operation.target.sessionID?.let { JsonValue.of(it) } ?: JsonValue.Null),
            "projectID" to (operation.target.projectID?.let { JsonValue.of(it) } ?: JsonValue.Null),
        ),
        "kind" to JsonValue.of(operation.kind.wire),
        "payload" to JsonValue.of(BinaryEncoding.encode(operation.payload)),
        "createdAt" to JsonValue.of(operation.createdAt),
        "status" to JsonValue.of(operation.status.wire),
        "result" to (operation.result?.let { JsonValue.of(BinaryEncoding.encode(it)) } ?: JsonValue.Null),
    )

    private fun readOperation(value: JsonValue): PendingOperation {
        val target = value["target"]
        val sessionID = target?.get("sessionID")?.string
        val projectID = target?.get("projectID")?.string
        val payload = value["payload"]?.string?.let { BinaryEncoding.decodeOrNull(it, null) } ?: throw invalid()
        val status = OperationStatus.fromWire(value["status"]?.string ?: throw invalid()) ?: throw invalid()
        val result = value["result"]?.string?.let { BinaryEncoding.decodeOrNull(it, null) ?: throw invalid() }
        val operation = PendingOperation(
            id = runCatching { UUID.fromString(value["id"]?.string ?: throw invalid()) }.getOrElse { throw invalid() },
            scope = readScope(value["scope"]),
            target = OperationTarget(target?.get("hostID")?.string ?: throw invalid(), target["runtimeID"]?.string ?: throw invalid(), sessionID, projectID),
            kind = OperationKind.fromWire(value["kind"]?.string ?: throw invalid()) ?: throw invalid(),
            payload = payload,
            createdAt = value["createdAt"]?.long ?: 0,
        )
        if (status != OperationStatus.Prepared) operation.transition(status, result)
        else operation.result = result
        return operation
    }

    private fun sessionJson(session: SessionCheckpoint): JsonValue = JsonValue.obj(
        "address" to addressJson(session.address),
        "state" to JsonValue.of(BinaryEncoding.encode(session.state)),
        "cursor" to JsonValue.of(session.cursor),
        "updatedAt" to JsonValue.of(session.updatedAt),
    )

    private fun readSession(value: JsonValue): SessionCheckpoint = SessionCheckpoint(
        address = readAddress(value["address"]),
        state = value["state"]?.string?.let { BinaryEncoding.decodeOrNull(it, null) } ?: throw invalid(),
        cursor = value["cursor"]?.long ?: throw invalid(),
        updatedAt = value["updatedAt"]?.long ?: 0,
    )

    private fun draftJson(draft: Draft): JsonValue = JsonValue.obj(
        "address" to addressJson(draft.address),
        "text" to JsonValue.of(draft.text),
    )

    private fun readDraft(value: JsonValue): Draft = Draft(
        address = readAddress(value["address"]),
        text = value["text"]?.string ?: throw invalid(),
    )

    private fun invalid(): ClientStateException = ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
}
