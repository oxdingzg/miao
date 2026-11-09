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
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonValue>>()
    private val outbound = Channel<ByteArray>(Channel.UNLIMITED)
    private val assembler = ResponseAssembler()
    private val stopped = AtomicBoolean(false)
    private val disconnect = CompletableDeferred<Throwable>()

    val target: RemoteTarget get() = host.target

    /** Revalidate authorization and reconcile the operation ledger before becoming ready. */
    suspend fun synchronize() {
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

    suspend fun close() {
        if (!stopped.compareAndSet(false, true)) return
        socket.cancel()
        scope.cancel()
        pending.values.forEach { it.completeExceptionally(RemoteRPCException.Disconnected()) }
        pending.clear()
        if (!disconnect.isCompleted) disconnect.complete(RemoteRPCException.Disconnected())
    }

    suspend fun awaitDisconnect(): Throwable = disconnect.await()

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
                    return PairedConnection(host, grant)
                }
            } catch (error: Throwable) {
                bridge.socket.cancel()
                if (provisional) throw PairingException(PairingException.Reason.APPROVAL_UNCERTAIN)
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
