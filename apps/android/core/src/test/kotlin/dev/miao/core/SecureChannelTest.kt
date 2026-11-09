package dev.miao.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class CanonicalJsonTest {
    @Test
    fun sortsObjectKeysAndKeepsArraysInOrder() {
        val value = JsonValue.obj(
            "b" to JsonValue.of(2),
            "a" to JsonValue.Arr(listOf(JsonValue.of(1), JsonValue.of(2))),
        )
        assertEquals("""{"a":[1,2],"b":2}""", CanonicalJson.encode(value))
    }

    @Test
    fun escapesLikeJsonStringify() {
        val value = JsonValue.obj(
            "text" to JsonValue.of("quote\" slash/ back\\ line\n control\u0001 tab\t"),
        )
        assertEquals(
            """{"text":"quote\" slash/ back\\ line\n control\u0001 tab\t"}""",
            CanonicalJson.encode(value),
        )
    }

    @Test
    fun normalizesIntegralNumbers() {
        assertEquals("1", CanonicalJson.encode(CanonicalJson.parse("1.0")))
        assertEquals("100", CanonicalJson.encode(CanonicalJson.parse("1e2")))
        assertEquals("1.5", CanonicalJson.encode(CanonicalJson.parse("1.50")))
        assertEquals("9007199254740991", CanonicalJson.encode(CanonicalJson.parse("9007199254740991")))
    }

    @Test
    fun parsesNestedDocument() {
        val value = CanonicalJson.parse("""{"a":{"b":[true,null,"x"]},"c":-1}""")
        assertEquals(JsonValue.Bool(true), value["a"]?.get("b")?.array?.get(0))
        assertEquals(JsonValue.Null, value["a"]?.get("b")?.array?.get(1))
        assertEquals(-1L, value["c"]?.long)
    }

    @Test
    fun rejectsTrailingAndMalformedInput() {
        assertFailsWith<JsonParseException> { CanonicalJson.parse("""{"a":1} extra""") }
        assertFailsWith<JsonParseException> { CanonicalJson.parse("{") }
    }

    @Test
    fun binaryEncodingIsStrict() {
        val bytes = ByteArray(65) { it.toByte() }
        val encoded = BinaryEncoding.encode(bytes)
        assertTrue(bytes.contentEquals(BinaryEncoding.decode(encoded)))
        assertEquals(null, BinaryEncoding.decodeOrNull(encoded + "=", null))
        assertEquals(null, BinaryEncoding.decodeOrNull("+" + encoded.drop(1), null))
        assertEquals(null, BinaryEncoding.decodeOrNull(encoded, 64))
    }
}

class CryptoTest {
    @Test
    fun hkdfMatchesRfc5869Vector() {
        val ikm = ByteArray(22) { 0x0b }
        val salt = hex("000102030405060708090a0b0c")
        val info = hex("f0f1f2f3f4f5f6f7f8f9")
        val okm = Crypto.hkdfSHA256(ikm, salt, info, 42)
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
            okm.toHex(),
        )
    }

    @Test
    fun signingKeyDerivesX963PublicPointOnCurve() {
        val key = P256SigningKey.generate()
        assertEquals(65, key.publicKey.size)
        assertEquals(4.toByte(), key.publicKey[0])
        assertTrue(P256Curve.isOnCurve(Crypto.pointOf(key.publicKey)))
    }

    @Test
    fun ecdsaRoundTripAndTamperRejection() {
        val key = P256SigningKey.generate()
        val data = "miao".toByteArray()
        val signature = key.sign(data)
        assertEquals(64, signature.size)
        assertTrue(Crypto.verify(key.publicKey, signature, data))
        assertTrue(!Crypto.verify(key.publicKey, signature, "other".toByteArray()))
        signature[0] = (signature[0].toInt() xor 1).toByte()
        assertTrue(!Crypto.verify(key.publicKey, signature, data))
    }

    @Test
    fun ecdhAgreesBothDirections() {
        val left = P256AgreementKey.generate()
        val right = P256AgreementKey.generate()
        assertTrue(left.secret(right.publicKey).contentEquals(right.secret(left.publicKey)))
        assertTrue(left.secret(right.publicKey).size == 32)
    }

    @Test
    fun offCurvePointIsRejected() {
        val key = P256SigningKey.generate()
        val tampered = key.publicKey.copyOf()
        tampered[64] = (tampered[64].toInt() xor 1).toByte()
        assertFailsWith<MalformedMaterialException> { Crypto.pointOf(tampered) }
    }

    @Test
    fun gcmRejectsWrongAdditionalData() {
        val key = ByteArray(32) { 7 }
        val nonce = ByteArray(12) { 3 }
        val sealed = Crypto.aesGcmSeal(key, nonce, "payload".toByteArray(), "aad".toByteArray())
        assertTrue("payload".toByteArray().contentEquals(Crypto.aesGcmOpen(key, nonce, sealed, "aad".toByteArray())))
        assertFailsWith<javax.crypto.AEADBadTagException> {
            Crypto.aesGcmOpen(key, nonce, sealed, "other".toByteArray())
        }
    }

    private fun hex(value: String): ByteArray =
        value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}

class SecureChannelTest {
    private val hostIdentity = P256SigningKey.generate()
    private val deviceIdentity = P256SigningKey.generate()
    private val target = RemoteTarget("interop-host-00000000", "interop-runtime-00000000")

    @Test
    fun handshakeConnectsBothDirections() {
        runBlocking {
        val client = ClientHandshake(deviceIdentity, target)
        val accepted = HostHandshake.accept(
            identity = hostIdentity,
            target = target,
            connectionID = "interop-connection-000000",
            client = client.hello,
            trustedDeviceKey = deviceIdentity.publicKeyEncoded,
        )
        val clientSession = client.finish(accepted.hello, hostIdentity.publicKeyEncoded)

        val fromClient = clientSession.seal("hello host".toByteArray())
        assertEquals("hello host", String(accepted.session.open(fromClient)))

            val fromHost = accepted.session.seal("hello device".toByteArray())
            assertEquals("hello device", String(clientSession.open(fromHost)))
        }
    }

    @Test
    fun helloJsonRoundTripsThroughCanonicalEncoding() {
        val client = ClientHandshake(deviceIdentity, target)
        val parsed = ClientHello.fromJson(CanonicalJson.parse(CanonicalJson.encode(client.hello.asJson())))
        assertEquals(client.hello, parsed)
        val accepted = HostHandshake.accept(hostIdentity, target, "interop-connection-000000", parsed, deviceIdentity.publicKeyEncoded)
        assertEquals(accepted.hello, ServerHello.fromJson(CanonicalJson.parse(CanonicalJson.encode(accepted.hello.asJson()))))
    }

    @Test
    fun clientRejectsUntrustedHostKey() {
        val client = ClientHandshake(deviceIdentity, target)
        val accepted = HostHandshake.accept(hostIdentity, target, "interop-connection-000000", client.hello, deviceIdentity.publicKeyEncoded)
        val wrong = P256SigningKey.generate().publicKeyEncoded
        assertFailsWith<ChannelException> { client.finish(accepted.hello, wrong) }
    }

    @Test
    fun serverRejectsUntrustedDeviceKey() {
        val client = ClientHandshake(deviceIdentity, target)
        assertFailsWith<ChannelException> {
            HostHandshake.accept(hostIdentity, target, "interop-connection-000000", client.hello, P256SigningKey.generate().publicKeyEncoded)
        }
    }

    @Test
    fun handshakeFinishesOnce() {
        val client = ClientHandshake(deviceIdentity, target)
        val accepted = HostHandshake.accept(hostIdentity, target, "interop-connection-000000", client.hello, deviceIdentity.publicKeyEncoded)
        client.finish(accepted.hello, hostIdentity.publicKeyEncoded)
        assertFailsWith<ChannelException> { client.finish(accepted.hello, hostIdentity.publicKeyEncoded) }
    }

    @Test
    fun replayedAndTamperedFramesAreRejected() {
        runBlocking {
        val client = ClientHandshake(deviceIdentity, target)
        val accepted = HostHandshake.accept(hostIdentity, target, "interop-connection-000000", client.hello, deviceIdentity.publicKeyEncoded)
        val clientSession = client.finish(accepted.hello, hostIdentity.publicKeyEncoded)
        val packet = clientSession.seal("first".toByteArray())
        assertEquals("first", String(accepted.session.open(packet)))
        assertFailsWith<ChannelException> { accepted.session.open(packet) }

        val tampered = BinaryEncoding.decode(packet)
        tampered[tampered.size - 1] = (tampered[tampered.size - 1].toInt() xor 1).toByte()
        val next = clientSession.seal("second".toByteArray())
        assertNotEquals(packet, next)
            assertFailsWith<ChannelException> { accepted.session.open(BinaryEncoding.encode(tampered)) }
        }
    }

    @Test
    fun channelTranscriptsAreSignatureDomainSeparated() {
        val client = ClientHandshake(deviceIdentity, target)
        val accepted = HostHandshake.accept(hostIdentity, target, "interop-connection-000000", client.hello, deviceIdentity.publicKeyEncoded)
        client.finish(accepted.hello, hostIdentity.publicKeyEncoded)
        val signature = BinaryEncoding.decode(client.hello.signature, 64)
        val transcript = canonicalTranscript("miao.control.client.v1", client.hello.payload())
        assertTrue(Crypto.verify(deviceIdentity.publicKey, signature, transcript))
        val wrongDomain = canonicalTranscript("miao.control.server.v1", client.hello.payload())
        assertTrue(!Crypto.verify(deviceIdentity.publicKey, signature, wrongDomain))
    }
}
