package dev.miao.core

import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * All callers share one store per authorization scope. A write completes before
 * an operation may be transmitted or a cursor exposed.
 *
 * Neither a successful socket write nor a reconnect is an operation receipt:
 * [reconciliation] returns uncertain entries to query, never to resend.
 */
class CheckpointStore(directory: File, val scope: AuthorizationScope) {
    private val file: File = File(directory, hashName(scope))
    private val mutex = Mutex()
    private var checkpoint: ClientCheckpoint? = null
    private val maximumBytes = 16 * 1024 * 1024

    suspend fun snapshot(): ClientCheckpoint = mutex.withLock { load() }

    suspend fun prepare(operation: PendingOperation): PendingOperation = mutex.withLock {
        if (operation.scope != scope || operation.target.hostID != scope.hostID) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
        val current = load()
        val existing = current.operations.firstOrNull { it.id == operation.id }
        if (existing != null) {
            if (
                existing.scope != operation.scope || existing.target != operation.target ||
                existing.kind != operation.kind || !existing.payload.contentEquals(operation.payload)
            ) {
                throw ClientStateException(ClientStateException.Reason.OPERATION_CONFLICT)
            }
            return@withLock existing
        }
        if (operation.status != OperationStatus.Prepared) throw ClientStateException(ClientStateException.Reason.INVALID_TRANSITION)
        val next = current.copy(operations = current.operations + operation)
        persist(next)
        operation
    }

    suspend fun markSending(id: UUID) = mutex.withLock {
        val current = load()
        val index = current.operations.indexOfFirst { it.id == id }
        if (index < 0) throw ClientStateException(ClientStateException.Reason.OPERATION_MISSING)
        if (current.operations[index].status != OperationStatus.Prepared) {
            throw ClientStateException(ClientStateException.Reason.INVALID_TRANSITION)
        }
        current.operations[index].transition(OperationStatus.AwaitingConfirmation, null)
        persist(current)
    }

    suspend fun resolve(id: UUID, status: OperationStatus, result: ByteArray? = null) = mutex.withLock {
        val current = load()
        val index = current.operations.indexOfFirst { it.id == id }
        if (index < 0) throw ClientStateException(ClientStateException.Reason.OPERATION_MISSING)
        current.operations[index].transition(status, result)
        persist(current)
    }

    suspend fun reconciliation(): List<PendingOperation> = mutex.withLock {
        load().operations.filter {
            it.status == OperationStatus.Prepared ||
                it.status == OperationStatus.AwaitingConfirmation ||
                it.status == OperationStatus.OutcomeUnknown
        }
    }

    suspend fun save(session: SessionCheckpoint) = mutex.withLock {
        if (session.address.hostID != scope.hostID || session.cursor < 0) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
        val current = load()
        val index = current.sessions.indexOfFirst { it.address == session.address }
        val next = if (index < 0) {
            current.copy(sessions = current.sessions + session)
        } else {
            if (session.cursor < current.sessions[index].cursor) throw ClientStateException(ClientStateException.Reason.STALE_CURSOR)
            current.copy(sessions = current.sessions.toMutableList().also { it[index] = session })
        }
        persist(next)
    }

    suspend fun save(draft: Draft) = mutex.withLock {
        if (draft.address.hostID != scope.hostID) throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        val current = load()
        val others = current.drafts.filterNot { it.address == draft.address }
        persist(current.copy(drafts = if (draft.text.isEmpty()) others else others + draft))
    }

    suspend fun clear() = mutex.withLock {
        if (file.exists()) file.delete()
        checkpoint = ClientCheckpoint(scope = scope)
    }

    private fun load(): ClientCheckpoint {
        checkpoint?.let { return it }
        if (!file.exists()) {
            val empty = ClientCheckpoint(scope = scope)
            checkpoint = empty
            return empty
        }
        if (!file.isFile || file.length() > maximumBytes) throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        val saved = CheckpointCodec.decode(file.readBytes())
        if (saved.scope != scope) throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        checkpoint = saved
        return saved
    }

    private fun persist(next: ClientCheckpoint) {
        next.validate()
        val bytes = CheckpointCodec.encode(next)
        if (bytes.size > maximumBytes) throw ClientStateException(ClientStateException.Reason.LIMIT_EXCEEDED)
        val directory = file.parentFile
        if (directory != null && !directory.exists() && !directory.mkdirs()) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        val temporary = File(directory, ".checkpoint-" + UUID.randomUUID())
        try {
            FileOutputStream(temporary).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            if (!temporary.renameTo(file)) {
                if (file.exists() && !file.delete()) throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
                if (!temporary.renameTo(file)) throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
        checkpoint = next
    }

    companion object {
        private fun hashName(scope: AuthorizationScope): String {
            val key = JsonValue.obj(
                "deviceID" to JsonValue.of(scope.deviceID),
                "grantID" to JsonValue.of(scope.grantID),
                "hostID" to JsonValue.of(scope.hostID),
            )
            return Crypto.sha256(CanonicalJson.encodeBytes(key)).joinToString("") { "%02x".format(it) } + ".json"
        }
    }
}
