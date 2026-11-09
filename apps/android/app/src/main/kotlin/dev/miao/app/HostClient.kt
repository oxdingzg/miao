package dev.miao.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.miao.core.AuthorizationBlockedException
import dev.miao.core.AuthorizationScope
import dev.miao.core.AuthorizedHost
import dev.miao.core.CanonicalJson
import dev.miao.core.CheckpointStore
import dev.miao.core.ClientScenePhase
import dev.miao.core.ConnectionCoordinator
import dev.miao.core.DeviceIdentity
import dev.miao.core.HubAccount
import dev.miao.core.HubConnection
import dev.miao.core.JsonValue
import dev.miao.core.OperationKind
import dev.miao.core.OperationStatus
import dev.miao.core.OperationTarget
import dev.miao.core.PendingOperation
import dev.miao.core.ProtocolIncompatibleException
import dev.miao.core.RemoteConnectionState
import dev.miao.core.RemoteMethod
import dev.miao.core.RemotePermission
import dev.miao.core.RemoteRPCException
import dev.miao.core.SessionAddress
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class HostClient(
    initial: AuthorizedHost,
    private val identity: DeviceIdentity,
    directory: File,
    private val account: HubAccount?,
    val scope: CoroutineScope,
) {
    var record by mutableStateOf(initial)
        private set
    val store = CheckpointStore(
        directory,
        AuthorizationScope(initial.grant.publicKey, initial.grant.id, initial.host.target.hostID),
    )
    var state by mutableStateOf(RemoteConnectionState.QUIESCENT)
    var projects by mutableStateOf<List<JsonValue>>(emptyList())
    var lists by mutableStateOf<Map<String, List<SessionSummary>>>(emptyMap())
    var next by mutableStateOf<Map<String, String>>(emptyMap())
    var operations by mutableStateOf<List<PendingOperation>>(emptyList())
    var error by mutableStateOf<String?>(null)
    var providers by mutableStateOf<ProviderDirectory?>(null)
    var providersError by mutableStateOf<String?>(null)
    var inbox by mutableStateOf<List<InboxEntry>>(emptyList())
    var inboxError by mutableStateOf<String?>(null)
    var sendingTargets by mutableStateOf<Set<String>>(emptySet())

    val sessions = mutableStateMapOf<String, RemoteSession>()
    private val mutex = Mutex()
    private var connection: HubConnection? = null
    private var runtimeID = initial.host.target.runtimeID
    private var closed = false
    private var writes = 0
    private var scene: UUID? = null
    private var observer: Job? = null
    private val coordinator = ConnectionCoordinator(scope = scope, connect = { connect() })

    init {
        observer = scope.launch {
            coordinator.state.collect { value ->
                state = value
                if (value == RemoteConnectionState.READY) sessions.values.forEach { it.resume() }
                if (value != RemoteConnectionState.READY) sessions.values.forEach { it.pause() }
            }
        }
    }

    val ready: Boolean get() = state == RemoteConnectionState.READY && !record.expired && !closed
    val runtime: String get() = runtimeID

    fun connectionDescription(): String = when {
        record.expired -> "授权已过期，请在电脑上重新配对"
        state == RemoteConnectionState.READY -> "已连接"
        state == RemoteConnectionState.CONNECTING -> "正在连接…"
        state == RemoteConnectionState.SYNCING -> "正在同步会话…"
        state == RemoteConnectionState.AUTHORIZATION_BLOCKED -> "授权需要重新核对"
        state == RemoteConnectionState.PROTOCOL_BLOCKED -> "请更新电脑和 App 的版本"
        state == RemoteConnectionState.OFFLINE -> "离线，回到前台后会重新连接"
        state == RemoteConnectionState.DRAINING -> "正在断开连接…"
        else -> "等待连接"
    }

    fun sending(sessionID: String): Boolean = sendingTargets.contains(sessionID)

    suspend fun scene(id: UUID, phase: ClientScenePhase) = mutex.withLock {
        if (closed) return@withLock
        scene = id
        coordinator.scene(id, phase)
    }

    suspend fun removeScene(id: UUID) = mutex.withLock {
        coordinator.removeScene(id)
    }

    suspend fun close() = mutex.withLock {
        closed = true
        observer?.cancel()
        scene?.let { coordinator.removeScene(it) }
        connection?.close()
        sessions.values.forEach { it.drain() }
        while (writes > 0) delay(20)
        state = RemoteConnectionState.QUIESCENT
    }

    suspend fun request(
        method: RemoteMethod,
        sessionID: String? = null,
        projectID: String? = null,
        operationID: UUID? = null,
        payload: JsonValue = JsonValue.Obj(emptyMap()),
    ): JsonValue {
        val current = connection
        if (!ready || current == null) throw RemoteRPCException.Disconnected()
        return current.request(method, sessionID, projectID, operationID, payload)
    }

    private fun beginWrite() {
        writes += 1
    }

    private fun endWrite() {
        writes -= 1
    }

    private suspend fun connect(): HubConnection {
        val currentRecord = record
        if (currentRecord.accountID != null && account != null) {
            if (account.authenticatedAccountID() != currentRecord.accountID) throw AuthorizationBlockedException()
            val discovered = account.hosts().firstOrNull {
                it.hostID == currentRecord.host.target.hostID && it.runtimeID == currentRecord.host.target.runtimeID &&
                    it.online && it.revokedAt == null
            } ?: throw AuthorizationBlockedException()
            val admitted = HubConnection.autoAdmit(
                account = account,
                discovered = discovered,
                identity = identity.loadOrCreate(),
                accountAccess = true,
                existingID = currentRecord.id,
                persist = { _, _ -> },
                reconcile = { synchronize(it) },
            )
            if (closed) {
                admitted.connection.close()
                throw RemoteRPCException.Disconnected()
            }
            record = AuthorizedHost(admitted.host, admitted.grant, currentRecord.accountID)
            connection = admitted.connection
            try {
                synchronize(admitted.connection)
            } catch (error: Throwable) {
                admitted.connection.close()
                throw error
            }
            return admitted.connection
        }
        if (currentRecord.expired || closed) throw AuthorizationBlockedException()
        val currentAccount = account
        val opened = HubConnection.open(
            host = currentRecord.host,
            identity = identity.loadOrCreate(),
            // A paired host has no accountID of its own, but the relay socket still
            // requires the signed-in account's bearer credential.
            authorize = currentAccount?.let { acct ->
                suspend {
                    acct.relayAuthorization(
                        currentRecord.host.hubURL,
                        currentRecord.host.target.hostID,
                        currentRecord.host.target.runtimeID,
                    )
                }
            },
            reconcile = { synchronize(it) },
        )
        if (closed) {
            opened.close()
            throw RemoteRPCException.Disconnected()
        }
        runtimeID = opened.target.runtimeID
        sessions.values.forEach { it.updateRuntime(runtimeID) }
        connection = opened
        return opened
    }

    private suspend fun synchronize(connection: HubConnection) {
        if (closed) throw CancellationException()
        writes += 1
        try {
            // Query uncertain operations with their original IDs and payloads. Never resend them here.
            for (operation in store.reconciliation()) {
                val result = connection.request(
                    RemoteMethod.OperationGet,
                    sessionID = operation.target.sessionID,
                    projectID = operation.target.projectID,
                    payload = JsonValue.obj("operationID" to JsonValue.of(operation.id.toString().lowercase())),
                )
                if (closed) throw CancellationException()
                OperationStatus.fromWireStatus(result["status"]?.string)?.let { status ->
                    store.resolve(operation.id, status, CanonicalJson.encodeBytes(result))
                }
            }
            operations = store.snapshot().operations
            val projectsValue = connection.request(RemoteMethod.ProjectList)
            val data = projectsValue["data"]?.array ?: throw ProtocolIncompatibleException()
            projects = data
            if (record.accountID != null) {
                loadList(null, connection)
            } else {
                if (record.grant.sessionIDs.isNotEmpty()) loadList(null, connection)
                for (project in record.grant.projectIDs) loadList(project, connection)
            }
        } finally {
            writes -= 1
        }
    }

    private suspend fun loadList(
        project: String?,
        connection: HubConnection,
        more: Boolean = false,
        search: String? = null,
    ) {
        val key = project ?: ""
        val payload = linkedMapOf<String, JsonValue>("limit" to JsonValue.of(100))
        if (search != null) payload["search"] = JsonValue.of(search)
        else if (more) next[key]?.let { payload["cursor"] = JsonValue.of(it) }
        val result = connection.request(RemoteMethod.SessionList, projectID = project, payload = JsonValue.Obj(payload))
        if (closed) throw CancellationException()
        val data = result["data"]?.array ?: throw ProtocolIncompatibleException()
        val values = data.map { SessionSummary.parse(it) }
        lists = lists + (key to if (more) (lists[key] ?: emptyList()) + values else values)
        next = next + (key to (result["cursor"]?.get("next")?.string ?: ""))
    }

    suspend fun refreshLists(more: String? = null, search: String? = null) {
        val current = connection
        if (!ready || current == null) return
        try {
            if (more != null) {
                loadList(more.ifEmpty { null }, current, more = true)
                return
            }
            if (record.accountID != null) {
                loadList(null, current, search = search)
            } else {
                if (record.grant.sessionIDs.isNotEmpty()) loadList(null, current, search = search)
                for (project in record.grant.projectIDs) loadList(project, current, search = search)
            }
        } catch (error: Throwable) {
            this.error = userMessage(error)
        }
    }

    suspend fun reconcileOperations() {
        val current = connection
        if (!ready || current == null) return
        beginWrite()
        try {
            for (operation in store.reconciliation()) {
                val result = current.request(
                    RemoteMethod.OperationGet,
                    sessionID = operation.target.sessionID,
                    projectID = operation.target.projectID,
                    payload = JsonValue.obj("operationID" to JsonValue.of(operation.id.toString().lowercase())),
                )
                if (closed) throw CancellationException()
                OperationStatus.fromWireStatus(result["status"]?.string)?.let { status ->
                    store.resolve(operation.id, status, CanonicalJson.encodeBytes(result))
                }
            }
            operations = store.snapshot().operations
        } catch (error: Throwable) {
            this.error = userMessage(error)
        } finally {
            endWrite()
        }
    }

    fun session(summary: SessionSummary): RemoteSession {
        sessions[summary.id]?.let { return it }
        val value = RemoteSession(summary, this)
        sessions[summary.id] = value
        return value
    }

    suspend fun mutate(
        method: RemoteMethod,
        kind: OperationKind,
        target: OperationTarget,
        payload: JsonValue,
    ): JsonValue {
        val key = target.sessionID ?: "project:" + (target.projectID ?: "")
        val current = connection
        if (!ready || sendingTargets.contains(key) || current == null) throw RemoteRPCException.Disconnected()
        beginWrite()
        sendingTargets = sendingTargets + key
        try {
            val operation = PendingOperation(
                id = UUID.randomUUID(),
                scope = store.scope,
                target = target,
                kind = kind,
                payload = CanonicalJson.encodeBytes(payload),
                createdAt = System.currentTimeMillis(),
            )
            store.prepare(operation)
            if (closed) throw CancellationException()
            store.markSending(operation.id)
            try {
                val result = current.request(
                    method,
                    sessionID = target.sessionID,
                    projectID = target.projectID,
                    operationID = operation.id,
                    payload = payload,
                )
                val status = OperationStatus.fromWireStatus(result["status"]?.string)
                    ?: throw ProtocolIncompatibleException()
                store.resolve(operation.id, status, CanonicalJson.encodeBytes(result))
                operations = store.snapshot().operations
                if (status == OperationStatus.Rejected || status == OperationStatus.OutcomeUnknown) {
                    throw RemoteRPCException.Rejected(result["code"]?.string ?: "uncertain")
                }
                return result
            } catch (error: Throwable) {
                operations = runCatching { store.snapshot().operations }.getOrDefault(operations)
                throw error
            }
        } finally {
            sendingTargets = sendingTargets - key
            endWrite()
        }
    }

    val canConfigureProviders: Boolean
        get() = RemotePermission.ProviderConfigure in record.grant.permissions

    suspend fun loadProviders() {
        if (!ready) return
        try {
            providers = ProviderDirectory.parse(request(RemoteMethod.ProviderList)) ?: throw ProtocolIncompatibleException()
            providersError = null
        } catch (error: Throwable) {
            providersError = userMessage(error)
        }
    }

    suspend fun connectProviderKey(providerID: String, key: String) {
        configure(
            RemoteMethod.ProviderConnectKey,
            JsonValue.obj("providerID" to JsonValue.of(providerID), "key" to JsonValue.of(key)),
        )
    }

    suspend fun disconnectProvider(providerID: String) {
        configure(RemoteMethod.ProviderDisconnect, JsonValue.obj("providerID" to JsonValue.of(providerID)))
    }

    suspend fun setDefaultModel(model: ModelChoice) {
        configure(
            RemoteMethod.ModelDefault,
            JsonValue.obj(
                "providerID" to JsonValue.of(model.providerID),
                "modelID" to JsonValue.of(model.modelID),
            ),
        )
    }

    /** Provider writes carry a fresh operation id but stay out of the ledger: reconcile by re-reading. */
    private suspend fun configure(method: RemoteMethod, payload: JsonValue) {
        val result = request(method, operationID = UUID.randomUUID(), payload = payload)
        loadProviders()
        if (result["status"]?.string != "completed") {
            throw RemoteRPCException.Rejected(result["code"]?.string ?: "uncertain")
        }
    }

    suspend fun loadInbox() {
        if (!ready) return
        try {
            val value = request(RemoteMethod.PendingList)
            val data = value["data"]?.array ?: throw ProtocolIncompatibleException()
            inbox = data.map { InboxEntry.parse(it) }
            inboxError = null
        } catch (error: Throwable) {
            inboxError = userMessage(error)
        }
    }

    fun currentAddress(sessionID: String): SessionAddress =
        SessionAddress(record.host.target.hostID, runtimeID, sessionID)

    fun updateRuntime(id: String) {
        runtimeID = id
    }

    fun isClosed(): Boolean = closed
}

fun userMessage(error: Throwable): String = when (error) {
    is dev.miao.core.PairingException -> "配对未完成或授权结果待核对，请在电脑上检查设备状态"
    is dev.miao.core.ClientStateException -> "设备数据无法读取或保存，请解锁设备后重试"
    is AuthorizationBlockedException -> "授权或协议需要核对，请检查电脑上的设备接入状态"
    is ProtocolIncompatibleException -> "请更新电脑和 App 的版本"
    is RemoteRPCException.Rejected -> {
        if (error.code == "uncertain") "操作结果待核对，不会自动重新发送" else "状态或授权已更新，请刷新后再试"
    }
    else -> "连接暂时不可用，已保留输入，请重新连接后核对结果"
}
