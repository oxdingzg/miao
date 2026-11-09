package dev.miao.core

import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class RemoteConnectionState { QUIESCENT, CONNECTING, SYNCING, READY, OFFLINE, DRAINING, AUTHORIZATION_BLOCKED, PROTOCOL_BLOCKED }

enum class ClientScenePhase { ACTIVE, INACTIVE, BACKGROUND }

/** Close only transport resources here; never interrupt a host execution. */
interface ClientConnection {
    suspend fun synchronize()
    suspend fun close()
    suspend fun awaitDisconnect(): Throwable
}

/**
 * Shared by every scene for one signed-in Hub identity. Epochs fence callbacks
 * from cancelled handshakes and background transitions.
 */
class ConnectionCoordinator(
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val connect: suspend () -> ClientConnection,
) {
    private val mutex = Mutex()
    private val ownedScope = scope
    private val scenes = mutableMapOf<UUID, ClientScenePhase>()
    private var epoch = 0L
    private var connection: ClientConnection? = null
    private var task: Job? = null
    private var attempts = 0
    private val stateFlow = MutableStateFlow(RemoteConnectionState.QUIESCENT)

    val state: StateFlow<RemoteConnectionState> = stateFlow.asStateFlow()

    suspend fun scene(id: UUID, phase: ClientScenePhase) = mutex.withLock {
        scenes[id] = phase
        if (scenes.values.all { it == ClientScenePhase.BACKGROUND }) {
            quiesce()
            return@withLock
        }
        if (phase == ClientScenePhase.ACTIVE && stateFlow.value in setOf(RemoteConnectionState.QUIESCENT, RemoteConnectionState.OFFLINE, RemoteConnectionState.DRAINING)) {
            start()
        }
    }

    suspend fun removeScene(id: UUID) = mutex.withLock {
        scenes.remove(id)
        if (scenes.values.isNotEmpty() && scenes.values.all { it == ClientScenePhase.BACKGROUND }) {
            quiesce()
        }
    }

    suspend fun retry() = mutex.withLock {
        if (stateFlow.value == RemoteConnectionState.OFFLINE && scenes.values.contains(ClientScenePhase.ACTIVE)) start()
    }

    /** Only after explicit successful re-pairing or unlock, never from retry(). */
    suspend fun authorizationRestored() = mutex.withLock {
        if (stateFlow.value != RemoteConnectionState.AUTHORIZATION_BLOCKED) return@withLock
        setState(RemoteConnectionState.QUIESCENT)
        if (scenes.values.contains(ClientScenePhase.ACTIVE)) start()
    }

    suspend fun authorizationRevoked() = mutex.withLock {
        stop(RemoteConnectionState.AUTHORIZATION_BLOCKED)
    }

    private fun start() {
        epoch += 1
        val current = epoch
        task?.cancel()
        setState(RemoteConnectionState.CONNECTING)
        task = ownedScope.launch {
            try {
                val opened = connect()
                if (!accept(opened, current)) {
                    opened.close()
                    return@launch
                }
                try {
                    opened.synchronize()
                    finished(opened, current)
                } catch (error: Throwable) {
                    opened.close()
                    failed(error, current)
                }
            } catch (error: Throwable) {
                failed(error, current)
            }
        }
    }

    private suspend fun accept(opened: ClientConnection, current: Long): Boolean = mutex.withLock {
        if (epoch != current) return false
        connection = opened
        setState(RemoteConnectionState.SYNCING)
        true
    }

    private fun finished(opened: ClientConnection, current: Long) {
        if (epoch != current) return
        attempts = 0
        setState(RemoteConnectionState.READY)
        task = ownedScope.launch {
            failed(opened.awaitDisconnect(), current)
        }
    }

    private suspend fun failed(error: Throwable, current: Long) = mutex.withLock {
        if (epoch != current) return@withLock
        connection = null
        task = null
        when (error) {
            is AuthorizationBlockedException -> setState(RemoteConnectionState.AUTHORIZATION_BLOCKED)
            is ProtocolIncompatibleException -> setState(RemoteConnectionState.PROTOCOL_BLOCKED)
            else -> setState(RemoteConnectionState.OFFLINE)
        }
        if (stateFlow.value != RemoteConnectionState.OFFLINE || !scenes.values.contains(ClientScenePhase.ACTIVE)) return@withLock
        val base = minOf(30.0, 0.5 * Math.pow(2.0, minOf(attempts, 6).toDouble()))
        val delayMillis = (base * (0.75 + Math.random() * 0.5) * 1000).toLong()
        attempts += 1
        task = ownedScope.launch {
            delay(delayMillis)
            mutex.withLock {
                if (epoch == current && scenes.values.contains(ClientScenePhase.ACTIVE) && stateFlow.value == RemoteConnectionState.OFFLINE) {
                    start()
                }
            }
        }
    }

    private suspend fun quiesce() {
        if (stateFlow.value in setOf(
                RemoteConnectionState.AUTHORIZATION_BLOCKED,
                RemoteConnectionState.PROTOCOL_BLOCKED,
                RemoteConnectionState.QUIESCENT,
                RemoteConnectionState.DRAINING,
            )
        ) {
            return
        }
        stop(RemoteConnectionState.DRAINING)
    }

    private suspend fun stop(next: RemoteConnectionState) {
        epoch += 1
        val current = epoch
        task?.cancel()
        task = null
        val closing = connection
        connection = null
        setState(next)
        ownedScope.launch {
            closing?.close()
            mutex.withLock {
                if (epoch == current && next == RemoteConnectionState.DRAINING) setState(RemoteConnectionState.QUIESCENT)
            }
        }
    }

    private fun setState(next: RemoteConnectionState) {
        stateFlow.value = next
    }
}
