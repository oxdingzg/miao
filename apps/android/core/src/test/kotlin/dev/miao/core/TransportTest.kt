package dev.miao.core

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ResponseAssemblerTest {
    @Test
    fun passesThroughSingleResponses() {
        val packet = CanonicalJson.encodeBytes(JsonValue.obj("version" to JsonValue.of(1), "type" to JsonValue.of("result")))
        assertTrue(packet.contentEquals(ResponseAssembler().append(packet)))
    }

    @Test
    fun reassemblesOrderedChunks() {
        val transfer = UUID.randomUUID().toString()
        val body = "0123456789".toByteArray()
        val first = chunk(transfer, 0, 2, body.copyOfRange(0, 5))
        val second = chunk(transfer, 1, 2, body.copyOfRange(5, 10))
        val assembler = ResponseAssembler()
        assertNull(assembler.append(first))
        val complete = assembler.append(second)
        assertNotNull(complete)
        assertEquals("0123456789", String(complete))
    }

    @Test
    fun rejectsOutOfOrderAndInconsistentChunks() {
        val transfer = UUID.randomUUID().toString()
        val assembler = ResponseAssembler()
        assertFailsWith<RemoteRPCException.Malformed> { assembler.append(chunk(transfer, 1, 2, "b".toByteArray())) }
        assertNull(assembler.append(chunk(transfer, 0, 2, "a".toByteArray())))
        assertFailsWith<RemoteRPCException.Malformed> { assembler.append(chunk(UUID.randomUUID().toString(), 1, 2, "b".toByteArray())) }
        assertFailsWith<RemoteRPCException.Malformed> { assembler.append(chunk(transfer, 0, 2, "b".toByteArray())) }
    }

    @Test
    fun rejectsUnexpectedTypesAndOversizedTotals() {
        val wrongType = CanonicalJson.encodeBytes(JsonValue.obj("version" to JsonValue.of(1), "type" to JsonValue.of("pairing")))
        assertFailsWith<RemoteRPCException.Malformed> { ResponseAssembler().append(wrongType) }
        assertFailsWith<RemoteRPCException.Malformed> {
            ResponseAssembler().append(chunk(UUID.randomUUID().toString(), 0, 129, "a".toByteArray()))
        }
    }

    private fun chunk(transfer: String, index: Int, total: Int, payload: ByteArray): ByteArray =
        CanonicalJson.encodeBytes(
            JsonValue.obj(
                "version" to JsonValue.of(1),
                "type" to JsonValue.of("chunk"),
                "transferID" to JsonValue.of(transfer),
                "index" to JsonValue.of(index),
                "total" to JsonValue.of(total),
                "payload" to JsonValue.of(BinaryEncoding.encode(payload)),
            ),
        )
}

class RemoteRequestTest {
    @Test
    fun encodesOperationIDAndTargets() {
        val operation = UUID.fromString("0f8fad5b-d9cb-469f-a165-70867728950e")
        val request = RemoteRequest(
            requestID = "9b2f1f3e-1111-4111-8111-111111111111",
            hostID = "interop-host-00000000",
            runtimeID = "interop-runtime-00000000",
            grantID = "interop-grant-0000000",
            grantVersion = 3,
            method = RemoteMethod.SessionPrompt,
            sessionID = "session-identifier-0001",
            operationID = operation.toString(),
            payload = JsonValue.obj("text" to JsonValue.of("hi"), "delivery" to JsonValue.of("steer")),
        )
        val value = CanonicalJson.parse(request.encode())
        assertEquals("session.prompt", value["method"]?.string)
        assertEquals("0f8fad5b-d9cb-469f-a165-70867728950e", value["operationID"]?.string)
        assertEquals("hi", value["payload"]?.get("text")?.string)
        assertEquals(3L, value["grantVersion"]?.long)
    }

    @Test
    fun endpointValidationIsStrict() {
        val https = clientEndpoint(java.net.URI("https://relay.example.invalid").toURL(), "interop-host-00000000", false)
        assertEquals("wss://relay.example.invalid/v1/client?hostID=interop-host-00000000", https)
        assertFailsWith<RemoteRPCException.InvalidEndpoint> {
            clientEndpoint(java.net.URI("http://relay.example.invalid").toURL(), "interop-host-00000000", false)
        }
        assertFailsWith<RemoteRPCException.InvalidEndpoint> {
            clientEndpoint(java.net.URI("https://relay.example.invalid/path").toURL(), "interop-host-00000000", false)
        }
        val local = clientEndpoint(java.net.URI("http://127.0.0.1:8080").toURL(), "interop-host-00000000", true, "interop-runtime-00000000")
        assertEquals("ws://127.0.0.1:8080/v1/client?hostID=interop-host-00000000&runtimeID=interop-runtime-00000000", local)
    }
}

class PairingTest {
    private val hostIdentity = P256SigningKey.generate()
    private val deviceIdentity = P256SigningKey.generate()

    private fun invitation(
        expiresAt: Long = System.currentTimeMillis() + 120_000,
        hubURL: String = "https://relay.example.invalid",
    ) = PairingInvitation(
        version = 1,
        pairingID = "interop-pairing-00000000",
        secret = "0f".repeat(32),
        hubURL = hubURL,
        hostID = "interop-host-00000000",
        runtimeID = "interop-runtime-00000000",
        hostPublicKey = hostIdentity.publicKeyEncoded,
        expiresAt = expiresAt,
    )

    private fun encode(invitation: PairingInvitation): String {
        val payload = JsonValue.obj(
            "version" to JsonValue.of(invitation.version),
            "pairingID" to JsonValue.of(invitation.pairingID),
            "secret" to JsonValue.of(invitation.secret),
            "hubURL" to JsonValue.of(invitation.hubURL),
            "hostID" to JsonValue.of(invitation.hostID),
            "runtimeID" to JsonValue.of(invitation.runtimeID),
            "hostPublicKey" to JsonValue.of(invitation.hostPublicKey),
            "expiresAt" to JsonValue.of(invitation.expiresAt),
        )
        return "miao://pair#" + BinaryEncoding.encode(CanonicalJson.encodeBytes(payload))
    }

    @Test
    fun parsesCanonicalInvitationUri() {
        val uri = encode(invitation())
        val parsed = PairingInvitation.parse(uri)
        assertEquals("interop-pairing-00000000", parsed.pairingID)
        assertEquals("https://relay.example.invalid", parsed.hubURL)
    }

    @Test
    fun rejectsMalformedUris() {
        assertFailsWith<PairingException> { PairingInvitation.parse("miao://other#" + BinaryEncoding.encode("{}".toByteArray())) }
        assertFailsWith<PairingException> { PairingInvitation.parse("https://relay.example.invalid") }
        assertFailsWith<PairingException> { PairingInvitation.parse(encode(invitation(expiresAt = System.currentTimeMillis() - 1))) }
        assertFailsWith<PairingException> { PairingInvitation.parse(encode(invitation(hubURL = "http://relay.example.invalid"))) }
        assertFailsWith<PairingException> { PairingInvitation.parse(encode(invitation()).take(200) + "!") }
    }

    @Test
    fun claimBindsProofToTheExactTranscript() {
        val parsed = PairingInvitation.parse(encode(invitation()))
        val hello = ClientHandshake(deviceIdentity, parsed.target).hello
        val claim = CanonicalJson.parse(parsed.claim("Pixel", hello))
        assertEquals("interop-pairing-00000000", claim["pairingID"]?.string)
        assertEquals("Pixel", claim["label"]?.string)
        val proof = claim["proof"]?.string
        assertNotNull(proof)
        assertEquals(64, proof.length)
        val expected = Crypto.hmacSHA256(
            "0f".repeat(32).chunked(2).map { it.toInt(16).toByte() }.toByteArray(),
            canonicalTranscript("miao.control.pair.v1", JsonValue.of(parsed.pairingID), JsonValue.of("Pixel"), hello.asJson()),
        ).joinToString("") { "%02x".format(it) }
        assertEquals(expected, proof)
        assertFailsWith<PairingException> { parsed.claim("", hello) }
    }

    @Test
    fun grantRoundTripsAndValidatesScope() {
        val deviceKey = deviceIdentity.publicKeyEncoded
        val grant = DeviceGrant(
            id = "interop-grant-000000",
            version = 1,
            publicKey = deviceKey,
            label = "Pixel",
            permissions = listOf(RemotePermission.Read, RemotePermission.Prompt),
            projectIDs = listOf("project-identifier-0001"),
            sessionIDs = emptyList(),
            createdAt = 1_700_000_000_000,
            expiresAt = System.currentTimeMillis() + 60_000,
        )
        grant.validate(deviceKey)
        assertEquals(grant, DeviceGrant.fromJson(CanonicalJson.parse(CanonicalJson.encode(grant.toJson()))))
        assertFailsWith<PairingException> { grant.validate(P256SigningKey.generate().publicKeyEncoded) }
        assertFailsWith<PairingException> { grant.copy(revokedAt = 1).validate(deviceKey) }
        assertFailsWith<PairingException> { grant.copy(expiresAt = 0).validate(deviceKey) }
        assertFailsWith<PairingException> { grant.copy(permissions = emptyList()).validate(deviceKey) }
        assertFailsWith<PairingException> { grant.copy(projectIDs = emptyList(), sessionIDs = emptyList()).validate(deviceKey) }
    }

    @Test
    fun fingerprintHashesTheX963Point() {
        val fingerprint = DeviceFingerprint.of(deviceIdentity.publicKey)
        assertEquals(BinaryEncoding.encode(Crypto.sha256(deviceIdentity.publicKey)), fingerprint)
    }
}
