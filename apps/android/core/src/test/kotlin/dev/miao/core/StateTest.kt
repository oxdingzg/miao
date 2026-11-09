package dev.miao.core

import java.io.File
import java.util.UUID
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class CheckpointStoreTest {
    private val scope = AuthorizationScope("device", "grant", "host")
    private val address = SessionAddress("host", "runtime", "session")
    private val directory: File by lazy { createTempDirectory("miao-checkpoint").toFile() }

    private fun operation(): PendingOperation = PendingOperation(
        id = UUID.randomUUID(),
        scope = scope,
        target = OperationTarget.of(address),
        kind = OperationKind.Prompt,
        payload = "{\"text\":\"hi\"}".toByteArray(),
        createdAt = 1_700_000_000_000,
    )

    @Test
    fun prepareSendingAndResolveFollowTheLedger() {
        runBlocking {
            val store = CheckpointStore(directory, scope)
            val operation = operation()
            store.prepare(operation)
            assertEquals(listOf(OperationStatus.Prepared), store.reconciliation().map { it.status })

            store.markSending(operation.id)
            assertEquals(listOf(OperationStatus.AwaitingConfirmation), store.reconciliation().map { it.status })

            store.resolve(operation.id, OperationStatus.Completed, "ok".toByteArray())
            assertTrue(store.reconciliation().isEmpty())
            assertEquals(OperationStatus.Completed, store.snapshot().operations.single().status)

            assertFailsWith<ClientStateException> { store.markSending(operation.id) }
            assertFailsWith<ClientStateException> { store.resolve(UUID.randomUUID(), OperationStatus.Completed) }
        }
    }

    @Test
    fun conflictAndScopeMismatchAreRejected() {
        runBlocking {
            val store = CheckpointStore(directory, scope)
            val operation = operation()
            store.prepare(operation)
            assertFailsWith<ClientStateException> {
                store.prepare(operation.copy(payload = "different".toByteArray()))
            }
            assertFailsWith<ClientStateException> {
                store.prepare(operation.copy(id = UUID.randomUUID(), scope = scope.copy(grantID = "other")))
            }
        }
    }

    @Test
    fun uncertainOperationsSurviveReopen() {
        runBlocking {
            val store = CheckpointStore(directory, scope)
            val prepared = operation()
            val sending = operation()
            store.prepare(prepared)
            store.prepare(sending)
            store.markSending(sending.id)

            val reopened = CheckpointStore(directory, scope)
            assertEquals(
                setOf(OperationStatus.Prepared, OperationStatus.AwaitingConfirmation),
                reopened.reconciliation().map { it.status }.toSet(),
            )
            assertEquals(2, reopened.snapshot().operations.size)
        }
    }

    @Test
    fun staleCursorAndEmptyDraftDeletion() {
        runBlocking {
            val store = CheckpointStore(directory, scope)
            store.save(SessionCheckpoint(address, "{}".toByteArray(), cursor = 10, updatedAt = 1))
            assertFailsWith<ClientStateException> {
                store.save(SessionCheckpoint(address.copy(runtimeID = "runtime"), "{}".toByteArray(), cursor = 5, updatedAt = 2))
            }
            store.save(SessionCheckpoint(address, "{}".toByteArray(), cursor = 11, updatedAt = 2))

            store.save(Draft(address, "draft"))
            assertEquals("draft", store.snapshot().drafts.single().text)
            store.save(Draft(address, ""))
            assertTrue(store.snapshot().drafts.isEmpty())
        }
    }

    @Test
    fun scopedStoresDoNotShareFiles() {
        runBlocking {
            val left = CheckpointStore(directory, scope)
            val right = CheckpointStore(directory, scope.copy(grantID = "other"))
            left.save(Draft(address, "left"))
            right.save(Draft(address, "right"))
            assertEquals("left", left.snapshot().drafts.single().text)
            assertEquals("right", right.snapshot().drafts.single().text)
            assertEquals(2, directory.listFiles()!!.count { it.name.endsWith(".json") })
        }
    }

    @Test
    fun checkpointRoundTripsThroughCanonicalJson() {
        val operation = operation()
        val checkpoint = ClientCheckpoint(
            scope = scope,
            operations = listOf(operation),
            sessions = listOf(SessionCheckpoint(address, "state".toByteArray(), 3, 1_700_000_000_000)),
            drafts = listOf(Draft(address, "草稿")),
        )
        checkpoint.validate()
        val decoded = CheckpointCodec.decode(CheckpointCodec.encode(checkpoint))
        assertEquals(1, decoded.operations.size)
        assertEquals(operation.id, decoded.operations.single().id)
        assertTrue(decoded.operations.single().payload.contentEquals(operation.payload))
        assertEquals("草稿", decoded.drafts.single().text)
        assertEquals(3, decoded.sessions.single().cursor)
        assertNotNull(decoded.sessions.single().state)
    }
}
