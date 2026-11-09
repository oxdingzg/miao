package dev.miao.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.miao.core.CanonicalJson
import dev.miao.core.ClientStateException
import dev.miao.core.Draft
import dev.miao.core.JsonParseException
import dev.miao.core.JsonValue
import dev.miao.core.LiveSessionProjection
import dev.miao.core.OperationKind
import dev.miao.core.OperationTarget
import dev.miao.core.RemoteMethod
import dev.miao.core.SessionAddress
import dev.miao.core.SessionCheckpoint
import dev.miao.core.SessionTimeline
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class RemoteSession(val summary: SessionSummary, private val client: HostClient) {
    private var address: SessionAddress = client.currentAddress(summary.id)
    var timeline by mutableStateOf(SessionTimeline())
        private set
    private var live by mutableStateOf<LiveSessionProjection?>(null)
    val visibleMessages: List<Map<String, JsonValue>>
        get() = live?.displaying(timeline.messages) ?: timeline.messages
    var pending by mutableStateOf<JsonValue>(JsonValue.Obj(emptyMap()))
    var draft by mutableStateOf("")
        private set
    var error by mutableStateOf<String?>(null)
    var loading by mutableStateOf(true)
    var diff by mutableStateOf<JsonValue?>(null)
    private var viewers = 0
    private var poll: Job? = null
    private var draftTail: Job? = null
    private var epoch = 0
    private var draftRevision = 0

    fun updateRuntime(runtimeID: String) {
        if (address.runtimeID == runtimeID) return
        pause()
        address = SessionAddress(address.hostID, runtimeID, address.sessionID)
        timeline = SessionTimeline()
        pending = JsonValue.Obj(emptyMap())
        loading = true
        edit(draft)
    }

    fun appear() {
        viewers += 1
        resume()
    }

    fun disappear() {
        viewers = maxOf(0, viewers - 1)
        if (viewers == 0) pause()
    }

    fun pause() {
        epoch += 1
        poll?.cancel()
        live = null
    }

    suspend fun drain() {
        val old = poll
        pause()
        old?.join()
        draftTail?.join()
    }

    fun resume() {
        if (viewers <= 0 || poll != null || !client.ready) return
        epoch += 1
        val generation = epoch
        val revision = draftRevision
        val captured = address
        poll = client.scope.launch {
            try {
                val checkpoint = client.store.snapshot()
                if (generation != epoch) return@launch
                checkpoint.sessions.firstOrNull { it.address == captured }?.let { saved ->
                    val value = SessionTimeline.fromJson(
                        try {
                            CanonicalJson.parse(saved.state)
                        } catch (_: JsonParseException) {
                            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
                        },
                    )
                    if (value.cursor != saved.cursor) throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
                    timeline = value
                }
                if (draftRevision == revision) {
                    val saved = checkpoint.drafts.firstOrNull { it.address == captured }
                        ?: checkpoint.drafts.lastOrNull {
                            it.address.hostID == captured.hostID && it.address.sessionID == captured.sessionID
                        }
                    if (saved != null) draft = saved.text
                }
                while (generation == epoch && client.ready) {
                    val page = client.request(
                        RemoteMethod.SessionEvents,
                        sessionID = summary.id,
                        payload = JsonValue.obj(
                            "after" to JsonValue.of(timeline.cursor),
                            "limit" to JsonValue.of(100),
                            "waitMs" to JsonValue.of(1000),
                        ),
                    )
                    if (generation != epoch) return@launch
                    val projection = LiveSessionProjection(page["live"])
                    val next = timeline.apply(page, summary.id)
                    if (next.cursor != timeline.cursor) {
                        client.store.save(
                            SessionCheckpoint(captured, CanonicalJson.encodeBytes(next.toJson()), next.cursor, System.currentTimeMillis()),
                        )
                        if (generation != epoch) return@launch
                        timeline = next
                    }
                    live = projection
                    loading = page["hasMore"]?.bool == true
                    if (!loading) {
                        val value = client.request(RemoteMethod.SessionPending, sessionID = summary.id)
                        if (generation != epoch) return@launch
                        pending = value
                    }
                }
            } catch (_: CancellationException) {
            } catch (error: Throwable) {
                if (generation == epoch) {
                    live = null
                    this@RemoteSession.error = userMessage(error)
                }
            } finally {
                poll = null
                if (generation != epoch && viewers > 0 && client.ready) resume()
            }
        }
    }

    fun edit(text: String) {
        draftRevision += 1
        draft = text
        val previous = draftTail
        val captured = Draft(address, text)
        draftTail = client.scope.launch {
            previous?.join()
            try {
                client.store.save(captured)
            } catch (error: Throwable) {
                this@RemoteSession.error = userMessage(error)
            }
        }
    }

    suspend fun send(queue: Boolean) {
        if (draft.trim().isEmpty()) return
        val text = draft
        val accepted = command(
            RemoteMethod.SessionPrompt,
            OperationKind.Prompt,
            JsonValue.obj("text" to JsonValue.of(text), "delivery" to JsonValue.of(if (queue) "queue" else "steer")),
        )
        if (accepted && draft == text) edit("")
    }

    suspend fun command(method: RemoteMethod, kind: OperationKind, payload: JsonValue): Boolean {
        error = null
        return try {
            client.mutate(method, kind, OperationTarget.of(address), payload)
            true
        } catch (failure: Throwable) {
            error = userMessage(failure)
            false
        }
    }

    /** One-time approval or question reply; the payload names the exact observed item. */
    suspend fun reply(method: RemoteMethod, kind: OperationKind, payload: JsonValue): Boolean = command(method, kind, payload)

    suspend fun interrupt(executionID: String?): Boolean =
        if (executionID == null) false
        else command(RemoteMethod.SessionInterrupt, OperationKind.Interrupt, JsonValue.obj("executionID" to JsonValue.of(executionID)))

    suspend fun rename(title: String): Boolean =
        command(RemoteMethod.SessionRename, OperationKind.SessionRename, JsonValue.obj("title" to JsonValue.of(title)))

    suspend fun pin(pinned: Boolean): Boolean =
        command(RemoteMethod.SessionPin, OperationKind.SessionPin, JsonValue.obj("pinned" to JsonValue.of(pinned)))

    suspend fun archive(archived: Boolean): Boolean =
        command(RemoteMethod.SessionArchive, OperationKind.SessionArchive, JsonValue.obj("archived" to JsonValue.of(archived)))

    suspend fun loadDiff() {
        try {
            diff = client.request(RemoteMethod.SessionDiff, sessionID = summary.id)
        } catch (error: Throwable) {
            this.error = userMessage(error)
        }
    }

    fun pendingApprovals(): List<JsonValue> =
        (pending["permissions"]?.array ?: emptyList()) + (pending["questions"]?.array ?: emptyList())
}
