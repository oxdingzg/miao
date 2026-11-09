package dev.miao.core

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

class SessionTimelineTest {
    private val sessionID = "session-identifier-0001"

    private fun event(type: String, sequence: Long, data: List<Pair<String, JsonValue>>, id: String = "message-" + sequence): JsonValue =
        JsonValue.obj(
            "durable" to JsonValue.obj(
                "seq" to JsonValue.of(sequence),
                "aggregateID" to JsonValue.of(sessionID),
                "version" to JsonValue.of(1),
                "id" to JsonValue.of(id),
            ),
            "type" to JsonValue.of(type),
            "data" to JsonValue.obj(*(data + ("sessionID" to JsonValue.of(sessionID)) + ("timestamp" to JsonValue.of(1_700_000_000_000))).toTypedArray()),
        )

    private fun page(events: List<JsonValue>, hasMore: Boolean = false): JsonValue =
        JsonValue.obj("data" to JsonValue.Arr(events), "hasMore" to JsonValue.of(hasMore), "cursor" to JsonValue.obj("next" to JsonValue.of("next")))

    @Test
    fun reducesPromptStepAndText() {
        val timeline = SessionTimeline()
            .apply(
                page(
                    listOf(
                        event("session.next.created", 1, listOf("info" to JsonValue.obj("title" to JsonValue.of("Plan the trip")))),
                        event("session.next.prompted", 2, listOf("messageID" to JsonValue.of("user-1"), "prompt" to JsonValue.obj("text" to JsonValue.of("hello")))),
                        event("session.next.step.started", 3, listOf("assistantMessageID" to JsonValue.of("assistant-1"), "agent" to JsonValue.of("build"), "model" to JsonValue.obj("id" to JsonValue.of("m")))),
                        event("session.next.text.started", 4, listOf("assistantMessageID" to JsonValue.of("assistant-1"), "textID" to JsonValue.of("text-1"))),
                        event("session.next.text.ended", 5, listOf("assistantMessageID" to JsonValue.of("assistant-1"), "textID" to JsonValue.of("text-1"), "text" to JsonValue.of("hello back"))),
                        event("session.next.step.ended", 6, listOf("assistantMessageID" to JsonValue.of("assistant-1"), "finish" to JsonValue.of("stop"))),
                    ),
                ),
                sessionID,
            )
        assertEquals(6, timeline.cursor)
        assertEquals("Plan the trip", timeline.title)
        assertEquals(listOf("user", "assistant"), timeline.messages.map { it["type"]?.string })
        val assistant = timeline.messages.last()
        assertEquals("hello back", assistant["content"]?.array?.single()?.get("text")?.string)
        assertNotNull(assistant["time"]?.get("completed"))
    }

    @Test
    fun toolLifecycleUpdatesOnePart() {
        val timeline = SessionTimeline().apply(
            page(
                listOf(
                    event("session.next.step.started", 1, listOf("assistantMessageID" to JsonValue.of("assistant-1"))),
                    event("session.next.tool.input.started", 2, listOf("assistantMessageID" to JsonValue.of("assistant-1"), "callID" to JsonValue.of("call-1"), "name" to JsonValue.of("bash"))),
                    event("session.next.tool.input.ended", 3, listOf("assistantMessageID" to JsonValue.of("assistant-1"), "callID" to JsonValue.of("call-1"), "text" to JsonValue.of("{\"command\":\"ls\"}"))),
                    event("session.next.tool.called", 4, listOf("assistantMessageID" to JsonValue.of("assistant-1"), "callID" to JsonValue.of("call-1"), "input" to JsonValue.obj("command" to JsonValue.of("ls")), "provider" to JsonValue.obj("executed" to JsonValue.of(true)))),
                    event("session.next.tool.success", 5, listOf("assistantMessageID" to JsonValue.of("assistant-1"), "callID" to JsonValue.of("call-1"), "structured" to JsonValue.obj("exit" to JsonValue.of(0)), "content" to JsonValue.Arr(listOf(JsonValue.obj("text" to JsonValue.of("a.txt")))))),
                ),
            ),
            sessionID,
        )
        val part = timeline.messages.last()["content"]?.array?.single() ?: throw AssertionError("missing part")
        assertEquals("tool", part["type"]?.string)
        assertEquals("bash", part["name"]?.string)
        assertEquals("completed", part["state"]?.get("status")?.string)
        assertEquals(0L, part["state"]?.get("structured")?.get("exit")?.long)
        assertEquals(true, part["provider"]?.get("executed")?.bool)
    }

    @Test
    fun rejectsStaleDuplicatesAndUnknownEvents() {
        val base = SessionTimeline().apply(
            page(listOf(event("session.next.prompted", 1, listOf("messageID" to JsonValue.of("user-1"))))),
            sessionID,
        )
        assertFailsWith<ProtocolIncompatibleException> {
            base.apply(page(listOf(event("session.next.prompted", 1, listOf("messageID" to JsonValue.of("user-1"))))), sessionID)
        }
        assertFailsWith<ProtocolIncompatibleException> {
            base.apply(page(listOf(event("session.next.unknown", 2, emptyList()))), sessionID)
        }
        assertFailsWith<ProtocolIncompatibleException> {
            base.apply(page(listOf(event("session.next.prompted", 2, listOf("messageID" to JsonValue.of("user-1"))))), sessionID)
        }
    }

    @Test
    fun rejectsPagesForOtherAggregatesAndMissingFlags() {
        val wrong = JsonValue.obj(
            "durable" to JsonValue.obj("seq" to JsonValue.of(1), "aggregateID" to JsonValue.of("other-session-0001"), "version" to JsonValue.of(1)),
            "type" to JsonValue.of("session.next.prompted"),
            "data" to JsonValue.obj("sessionID" to JsonValue.of("other-session-0001")),
        )
        assertFailsWith<ProtocolIncompatibleException> { SessionTimeline().apply(page(listOf(wrong)), sessionID) }
        assertFailsWith<ProtocolIncompatibleException> {
            SessionTimeline().apply(JsonValue.obj("data" to JsonValue.Arr(emptyList())), sessionID)
        }
    }

    @Test
    fun roundTripsThroughCheckpointJson() {
        val timeline = SessionTimeline().apply(
            page(listOf(event("session.next.prompted", 1, listOf("messageID" to JsonValue.of("user-1"))))),
            sessionID,
        )
        val restored = SessionTimeline.fromJson(CanonicalJson.parse(CanonicalJson.encode(timeline.toJson())))
        assertEquals(timeline, restored)
    }
}

class ConnectionCoordinatorTest {
    private class FakeConnection(private val ready: Boolean) : ClientConnection {
        val disconnected = kotlinx.coroutines.CompletableDeferred<Throwable>()

        override suspend fun synchronize() {
            if (!ready) throw ProtocolIncompatibleException()
        }

        override suspend fun close() {
            if (!disconnected.isCompleted) disconnected.complete(RemoteRPCException.Disconnected())
        }

        override suspend fun awaitDisconnect(): Throwable = disconnected.await()
    }

    @Test
    fun reachesReadyAndDrainsOnBackground() = runBlocking {
        val connection = FakeConnection(ready = true)
        val coordinator = ConnectionCoordinator(connect = { connection })
        val scene = UUID.randomUUID()
        coordinator.scene(scene, ClientScenePhase.ACTIVE)
        var state = coordinator.state.first { it == RemoteConnectionState.READY }
        assertEquals(RemoteConnectionState.READY, state)
        coordinator.scene(scene, ClientScenePhase.BACKGROUND)
        state = coordinator.state.first { it == RemoteConnectionState.QUIESCENT }
        assertEquals(RemoteConnectionState.QUIESCENT, state)
    }

    @Test
    fun protocolFailureBlocksInsteadOfRetrying() = runBlocking {
        val coordinator = ConnectionCoordinator(connect = { FakeConnection(ready = false) })
        coordinator.scene(UUID.randomUUID(), ClientScenePhase.ACTIVE)
        assertEquals(RemoteConnectionState.PROTOCOL_BLOCKED, coordinator.state.first { it == RemoteConnectionState.PROTOCOL_BLOCKED })
        assertTrue(coordinator.state.value == RemoteConnectionState.PROTOCOL_BLOCKED)
    }
}
