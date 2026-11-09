package dev.miao.core

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Transport never retries an operation, interrupts a session or decides its outcome. */
class HubConnection private constructor(
    private val host: ApprovedHost,
    private val socket: WebSocket,
    private val channel: SecureSession,
    private val reconcile: suspend (HubConnection) -> Unit,
) : ClientConnection {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonValue>>()
    private val outbound = Channel<ByteArray>(Channel.UNLIMITED)
    private val assembler = ResponseAssembler()
    private val stopped = AtomicBoolean(false)
    private val disconnect = CompletableDeferred<Throwable>()

    val target: RemoteTarget get() = host.target

    /** Revalidate authorization and reconcile the operation ledger before becoming ready. */
    override suspend fun synchronize() {
        request(RemoteMethod.Capabilities)
        reconcile(this)
    }

    suspend fun request(
        method: RemoteMethod,
        sessionID: String? = null,
        projectID: String? = null,
        operationID: UUID? = null,
        payload: JsonValue = JsonValue.Obj(emptyMap()),
    ): JsonValue {
        if (stopped.get()) throw RemoteRPCException.Disconnected()
        if (pending.size >= 8) throw RemoteRPCException.Overloaded()
        val id = UUID.randomUUID().toString().lowercase()
        val request = RemoteRequest(
            requestID = id,
            hostID = host.target.hostID,
            runtimeID = host.target.runtimeID,
            grantID = host.grantID,
            grantVersion = host.grantVersion,
            method = method,
            sessionID = sessionID,
            projectID = projectID,
            operationID = operationID?.toString()?.lowercase(),
            payload = payload,
        )
        val bytes = request.encode()
        if (bytes.size > 128 * 1024) throw RemoteRPCException.Overloaded()
        val waiter = CompletableDeferred<JsonValue>()
        pending[id] = waiter
        // Sealing happens in the single sender so channel sequences stay ordered.
        outbound.trySend(bytes)
        val result = withTimeoutOrNull(15_000) { waiter.await() }
        if (result == null) {
            pending.remove(id)
            throw RemoteRPCException.Timeout()
        }
        return result
    }

    override suspend fun close() {
        if (!stopped.compareAndSet(false, true)) return
        socket.cancel()
        scope.cancel()
        pending.values.forEach { it.completeExceptionally(RemoteRPCException.Disconnected()) }
        pending.clear()
        if (!disconnect.isCompleted) disconnect.complete(RemoteRPCException.Disconnected())
    }

    override suspend fun awaitDisconnect(): Throwable = disconnect.await()

    private fun start(socket: WebSocket, inbound: Channel<String>) {
        scope.launch { sendLoop(socket) }
        scope.launch { receiveLoop(inbound) }
    }

    private suspend fun sendLoop(socket: WebSocket) {
        for (bytes in outbound) {
            if (stopped.get()) return
            val sealed = try {
                channel.seal(bytes)
            } catch (error: Exception) {
                fail(error)
                return
            }
            if (!socket.send(sealed)) {
                fail(RemoteRPCException.Disconnected())
                return
            }
        }
    }

    private suspend fun receiveLoop(inbound: Channel<String>) {
        try {
            while (!stopped.get()) {
                val text = inbound.receiveCatching().getOrNull() ?: return
                if (stopped.get()) return
                val plaintext = channel.open(text)
                val complete = assembler.append(plaintext) ?: continue
                val response = RemoteResponse.fromJson(CanonicalJson.parse(complete))
                if (response.version != 1 || runCatching { UUID.fromString(response.requestID) }.isFailure) {
                    throw RemoteRPCException.Malformed()
                }
                val waiter = pending.remove(response.requestID) ?: continue
                when (response.type) {
                    "result" -> waiter.complete(response.data ?: throw RemoteRPCException.Malformed())
                    "error" -> waiter.completeExceptionally(RemoteRPCException.Rejected(response.code ?: ""))
                    else -> {
                        waiter.completeExceptionally(RemoteRPCException.Malformed())
                        throw RemoteRPCException.Malformed()
                    }
                }
            }
        } catch (error: Throwable) {
            fail(error)
        }
    }

    private fun fail(error: Throwable) {
        if (!stopped.compareAndSet(false, true)) return
        socket.cancel()
        scope.cancel()
        pending.values.forEach { it.completeExceptionally(error) }
        pending.clear()
        if (!disconnect.isCompleted) disconnect.complete(error)
    }

    companion object {
        private val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
                .writeTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                .build()
        }

        suspend fun open(
            host: ApprovedHost,
            identity: P256SigningKey,
            allowLoopbackHTTP: Boolean = false,
            authorize: (suspend () -> String?)? = null,
            reconcile: suspend (HubConnection) -> Unit,
        ): HubConnection {
            if (host.grantVersion <= 0) throw RemoteRPCException.InvalidEndpoint()
            val bearer = authorize?.invoke()
            val endpoint = clientEndpoint(
                java.net.URI(host.hubURL).toURL(),
                host.target.hostID,
                allowLoopbackHTTP,
                host.target.runtimeID,
            )
            val bridge = connect(endpoint, bearer)
            try {
                val handshake = ClientHandshake(identity, host.target)
                bridge.send(BinaryEncoding.encode(CanonicalJson.encodeBytes(handshake.hello.asJson())))
                val reply = bridge.receive(8192) ?: throw RemoteRPCException.Malformed()
                val serverHello = ServerHello.fromJson(CanonicalJson.parse(BinaryEncoding.decodeOrNull(reply, null) ?: throw RemoteRPCException.Malformed()))
                val channel = handshake.finish(serverHello, host.publicKey)
                val connection = HubConnection(host, bridge.socket, channel, reconcile)
                connection.start(bridge.socket, bridge.inbound)
                return connection
            } catch (error: Throwable) {
                bridge.socket.cancel()
                throw mapHandshakeError(error, bridge)
            }
        }

        /**
         * No RPC reader starts until local owner approval is verified and the caller
         * durably saves it. A lost approval is uncertain, never permission to send
         * business RPC.
         */
        suspend fun pair(
            invitation: PairingInvitation,
            identity: P256SigningKey,
            label: String,
            allowLoopbackHTTP: Boolean = false,
            authorize: (suspend () -> String?)? = null,
            pending: suspend (String) -> Unit,
            persist: suspend (ApprovedHost, DeviceGrant) -> Unit,
            reconcile: suspend (HubConnection) -> Unit,
        ): PairedConnection {
            invitation.validate(allowLoopbackHTTP = allowLoopbackHTTP)
            val bearer = authorize?.invoke()
            val endpoint = clientEndpoint(
                java.net.URI(invitation.hubURL).toURL(),
                invitation.hostID,
                allowLoopbackHTTP,
                invitation.runtimeID,
            )
            val bridge = connect(endpoint, bearer)
            val remaining = minOf(180_000L, invitation.expiresAt - nowMillis()).coerceAtLeast(0L)
            var provisional = false
            try {
                val handshake = ClientHandshake(identity, invitation.target)
                bridge.send(BinaryEncoding.encode(invitation.claim(label, handshake.hello)))
                val reply = bridge.receive(8192) ?: throw RemoteRPCException.Malformed()
                val serverHello = ServerHello.fromJson(CanonicalJson.parse(BinaryEncoding.decodeOrNull(reply, null) ?: throw RemoteRPCException.Malformed()))
                val channel = handshake.finish(serverHello, invitation.hostPublicKey)
                val assembler = ResponseAssembler(setOf("pairing"))
                while (true) {
                    val text = bridge.receiveOrNull(remaining) ?: throw RemoteRPCException.Timeout()
                    val plaintext = assembler.append(channel.open(text)) ?: continue
                    val notice = PairingNotification.fromJson(CanonicalJson.parse(plaintext))
                    if (notice.version != 1 || notice.type != "pairing") throw RemoteRPCException.Malformed()
                    if (!provisional) {
                        if (notice.status != "pending" || notice.pairingID != invitation.pairingID || notice.grant != null) {
                            throw RemoteRPCException.Malformed()
                        }
                        provisional = true
                        pending(DeviceFingerprint.of(identity.publicKey))
                        continue
                    }
                    if (notice.status != "approved") throw RemoteRPCException.Malformed()
                    val grant = notice.grant ?: throw RemoteRPCException.Malformed()
                    grant.validate(identity.publicKeyEncoded)
                    val host = ApprovedHost.create(
                        label = invitation.hostID,
                        hubURL = invitation.hubURL,
                        target = invitation.target,
                        publicKey = invitation.hostPublicKey,
                        grantID = grant.id,
                        grantVersion = grant.version,
                    )
                    persist(host, grant)
                    val connection = HubConnection(host, bridge.socket, channel, reconcile)
                    connection.start(bridge.socket, bridge.inbound)
                    return PairedConnection(host, grant, connection)
                }
            } catch (error: Throwable) {
                bridge.socket.cancel()
                if (provisional) throw PairingException(PairingException.Reason.APPROVAL_UNCERTAIN)
                throw mapHandshakeError(error, bridge)
            }
        }

        /**
         * Owner opt-in: same-account devices claim admission with the directory key
         * pinned on first use; the computer signs the roster locally and returns an
         * encrypted grant. No RPC reader starts before the caller durably saves it.
         */
        suspend fun autoAdmit(
            account: HubAccount,
            discovered: HubDirectoryHost,
            identity: P256SigningKey,
            accountAccess: Boolean = false,
            existingID: UUID? = null,
            persist: suspend (ApprovedHost, DeviceGrant) -> Unit,
            reconcile: suspend (HubConnection) -> Unit,
        ): PairedConnection {
            val (generation, accountID) = account.enrollmentContext()
            val deviceKey = identity.publicKeyEncoded
            if (!discovered.online || discovered.revokedAt != null || discovered.name.isEmpty()) {
                throw AuthorizationBlockedException()
            }
            val runtimeID = discovered.runtimeID ?: throw AuthorizationBlockedException()
            account.requireGeneration(generation)
            val target = RemoteTarget(discovered.hostID, runtimeID)
            val authorization = account.relayAuthorization(account.origin, target.hostID, runtimeID)
            return admitWithClaim(
                claimType = if (accountAccess) "accountClaim" else "rosterClaim",
                accountID = accountID,
                identity = identity,
                target = target,
                pinnedKey = discovered.publicKey,
                roster = null,
                authorization = authorization,
                label = discovered.name,
                hubURL = account.origin,
                existingID = existingID,
                generation = generation,
                account = account,
                persist = persist,
                reconcile = reconcile,
            )
        }

        /** Admission uses independently endorsed pins and an accepted local roster, never directory keys as authority. */
        suspend fun admit(
            account: HubAccount,
            enrollment: AcceptedAccountEnrollment,
            discovered: HubDirectoryHost,
            identity: P256SigningKey,
            existingID: UUID? = null,
            persist: suspend (ApprovedHost, DeviceGrant) -> Unit,
            reconcile: suspend (HubConnection) -> Unit,
        ): PairedConnection {
            val (generation, accountID) = account.enrollmentContext()
            val origin = account.origin
            val deviceKey = identity.publicKeyEncoded
            val runtimeID = discovered.runtimeID ?: throw AuthorizationBlockedException()
            val pin = enrollment.hosts.firstOrNull { it.hostID == discovered.hostID }
            if (
                enrollment.hubURL != origin ||
                enrollment.authority.accountID != accountID ||
                enrollment.roster.roster.accountID != accountID ||
                enrollment.roster.roster.devices.none { it.publicKey == deviceKey } ||
                pin == null || pin.publicKey != discovered.publicKey ||
                discovered.revokedAt != null || !discovered.online
            ) {
                throw AuthorizationBlockedException()
            }
            val accepted = enrollment.roster.accept(accountID, enrollment.authority)
            if (accepted != enrollment.authority) throw AuthorizationBlockedException()
            val directory = account.hosts()
            if (directory.none {
                    it.hostID == pin.hostID && it.runtimeID == runtimeID && it.publicKey == pin.publicKey &&
                        it.online && it.revokedAt == null
                }
            ) {
                throw AuthorizationBlockedException()
            }
            account.requireGeneration(generation)
            val target = RemoteTarget(pin.hostID, runtimeID)
            val authorization = account.relayAuthorization(origin, target.hostID, runtimeID)
            return admitWithClaim(
                claimType = "rosterClaim",
                accountID = accountID,
                identity = identity,
                target = target,
                pinnedKey = pin.publicKey,
                roster = enrollment.roster,
                authorization = authorization,
                label = discovered.name,
                hubURL = origin,
                existingID = existingID,
                generation = generation,
                account = account,
                persist = persist,
                reconcile = reconcile,
            )
        }

        private suspend fun admitWithClaim(
            claimType: String,
            accountID: String,
            identity: P256SigningKey,
            target: RemoteTarget,
            pinnedKey: String,
            roster: SignedAccountRoster?,
            authorization: String,
            label: String,
            hubURL: String,
            existingID: UUID?,
            generation: Long,
            account: HubAccount,
            persist: suspend (ApprovedHost, DeviceGrant) -> Unit,
            reconcile: suspend (HubConnection) -> Unit,
        ): PairedConnection {
            val endpoint = clientEndpoint(java.net.URI(hubURL).toURL(), target.hostID, false, target.runtimeID)
            val bridge = connect(endpoint, authorization)
            try {
                val handshake = ClientHandshake(identity, target)
                val claim = JsonValue.obj(
                    "version" to JsonValue.of(1),
                    "type" to JsonValue.of(claimType),
                    "accountID" to JsonValue.of(accountID),
                    "hello" to handshake.hello.asJson(),
                    "roster" to (roster?.toJson() ?: JsonValue.Null),
                )
                bridge.send(BinaryEncoding.encode(CanonicalJson.encodeBytes(claim)))
                val reply = bridge.receive(8192) ?: throw RemoteRPCException.Malformed()
                val serverHello = ServerHello.fromJson(
                    CanonicalJson.parse(BinaryEncoding.decodeOrNull(reply, null) ?: throw RemoteRPCException.Malformed()),
                )
                val channel = handshake.finish(serverHello, pinnedKey)
                val assembler = ResponseAssembler(setOf("roster"))
                while (true) {
                    val text = bridge.receiveOrNull(30_000) ?: throw RemoteRPCException.Timeout()
                    val plaintext = assembler.append(channel.open(text)) ?: continue
                    val approval = RosterNotification.fromJson(CanonicalJson.parse(plaintext))
                    if (approval.version != 1 || approval.type != "roster" || approval.status != "approved") {
                        throw RemoteRPCException.Malformed()
                    }
                    approval.grant.validate(identity.publicKeyEncoded)
                    account.requireGeneration(generation)
                    val host = ApprovedHost.create(
                        id = existingID ?: UUID.randomUUID(),
                        label = label,
                        hubURL = hubURL,
                        target = target,
                        publicKey = pinnedKey,
                        grantID = approval.grant.id,
                        grantVersion = approval.grant.version,
                    )
                    persist(host, approval.grant)
                    account.requireGeneration(generation)
                    val connection = HubConnection(host, bridge.socket, channel, reconcile)
                    connection.start(bridge.socket, bridge.inbound)
                    return PairedConnection(host, approval.grant, connection)
                }
            } catch (error: Throwable) {
                bridge.socket.cancel()
                throw mapHandshakeError(error, bridge)
            }
        }

        private fun mapHandshakeError(error: Throwable, bridge: Bridge): Throwable = when {
            error is ChannelException -> AuthorizationBlockedException()
            bridge.policyViolation -> AuthorizationBlockedException()
            bridge.unauthorized -> AuthorizationBlockedException()
            else -> error
        }

        private suspend fun connect(endpoint: String, bearer: String?): Bridge {
            val request = Request.Builder().url(endpoint).apply {
                bearer?.let { header("Authorization", "Bearer $it") }
            }.build()
            return withTimeoutOrNull(15_000) { client.newWebSocketBridge(request) } ?: throw RemoteRPCException.Timeout()
        }
    }
}

private class Bridge(val socket: WebSocket) {
    val inbound = Channel<String>(64)
    var policyViolation = false
    var unauthorized = false

    fun send(text: String) {
        if (!socket.send(text)) throw RemoteRPCException.Disconnected()
    }

    suspend fun receive(maxBytes: Int): String? {
        val text = inbound.receiveCatching().getOrNull() ?: return null
        if (text.length > maxBytes) throw RemoteRPCException.Malformed()
        return text
    }

    suspend fun receiveOrNull(timeoutMillis: Long): String? = withTimeoutOrNull(timeoutMillis) {
        inbound.receiveCatching().getOrNull()
    }
}

private suspend fun OkHttpClient.newWebSocketBridge(request: Request): Bridge {
    val opened = CompletableDeferred<Bridge>()
    val holder = java.util.concurrent.atomic.AtomicReference<Bridge?>(null)
    newWebSocket(
        request,
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val bridge = Bridge(webSocket)
                holder.set(bridge)
                opened.complete(bridge)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val current = holder.get() ?: return
                if (current.inbound.trySend(text).isFailure) webSocket.cancel()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                holder.get()?.policyViolation = code == 1008
                webSocket.close(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                val current = holder.get()
                if (current != null) {
                    current.unauthorized = response?.code == 401 || response?.code == 403
                    current.inbound.close()
                } else {
                    opened.completeExceptionally(error)
                }
            }
        },
    )
    return opened.await()
}
