package dev.miao.core

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class ChannelException(val reason: Reason) : Exception(reason.name) {
    enum class Reason {
        MALFORMED,
        UNTRUSTED_IDENTITY,
        CHALLENGE_MISMATCH,
        INVALID_SIGNATURE,
        HANDSHAKE_USED,
        REPLAY,
        EXHAUSTED,
        FRAME_TOO_LARGE,
    }
}

private val identifierPattern = Regex("^[A-Za-z0-9_-]{16,128}$")
private const val MAX_SEQUENCE = 9_007_199_254_740_991L
private const val MAX_PLAINTEXT = 128 * 1024
private const val MAX_ENCODED = 180 * 1024

data class RemoteTarget(val hostID: String, val runtimeID: String) {
    fun validate() {
        validateIdentifier(hostID)
        validateIdentifier(runtimeID)
    }
}

fun validateIdentifier(value: String) {
    if (!identifierPattern.matches(value)) throw ChannelException(ChannelException.Reason.MALFORMED)
}

data class ClientHello(
    val version: Int,
    val hostID: String,
    val runtimeID: String,
    val signingKey: String,
    val agreementKey: String,
    val challenge: String,
    val signature: String,
) {
    fun payload(): JsonValue = JsonValue.obj(
        "version" to JsonValue.of(version),
        "hostID" to JsonValue.of(hostID),
        "runtimeID" to JsonValue.of(runtimeID),
        "signingKey" to JsonValue.of(signingKey),
        "agreementKey" to JsonValue.of(agreementKey),
        "challenge" to JsonValue.of(challenge),
    )

    fun asJson(): JsonValue = JsonValue.Obj(linkedMapOf<String, JsonValue>().apply {
        putAll((payload() as JsonValue.Obj).entries)
        put("signature", JsonValue.of(signature))
    })

    companion object {
        fun fromJson(value: JsonValue): ClientHello = ClientHello(
            version = requiredInt(value, "version"),
            hostID = requiredString(value, "hostID"),
            runtimeID = requiredString(value, "runtimeID"),
            signingKey = requiredString(value, "signingKey"),
            agreementKey = requiredString(value, "agreementKey"),
            challenge = requiredString(value, "challenge"),
            signature = requiredString(value, "signature"),
        )
    }
}

data class ServerHello(
    val version: Int,
    val hostID: String,
    val runtimeID: String,
    val connectionID: String,
    val signingKey: String,
    val agreementKey: String,
    val challenge: String,
    val clientChallenge: String,
    val signature: String,
) {
    fun payload(): JsonValue = JsonValue.obj(
        "version" to JsonValue.of(version),
        "hostID" to JsonValue.of(hostID),
        "runtimeID" to JsonValue.of(runtimeID),
        "connectionID" to JsonValue.of(connectionID),
        "signingKey" to JsonValue.of(signingKey),
        "agreementKey" to JsonValue.of(agreementKey),
        "challenge" to JsonValue.of(challenge),
        "clientChallenge" to JsonValue.of(clientChallenge),
    )

    fun asJson(): JsonValue = JsonValue.Obj(linkedMapOf<String, JsonValue>().apply {
        putAll((payload() as JsonValue.Obj).entries)
        put("signature", JsonValue.of(signature))
    })

    companion object {
        fun fromJson(value: JsonValue): ServerHello = ServerHello(
            version = requiredInt(value, "version"),
            hostID = requiredString(value, "hostID"),
            runtimeID = requiredString(value, "runtimeID"),
            connectionID = requiredString(value, "connectionID"),
            signingKey = requiredString(value, "signingKey"),
            agreementKey = requiredString(value, "agreementKey"),
            challenge = requiredString(value, "challenge"),
            clientChallenge = requiredString(value, "clientChallenge"),
            signature = requiredString(value, "signature"),
        )
    }
}

/** The trust anchor must come from local pairing, never from relay metadata. */
class ClientHandshake(private val identity: P256SigningKey, val target: RemoteTarget) {
    private val agreement = P256AgreementKey.generate()
    private var finished = false

    val hello: ClientHello

    init {
        target.validate()
        val signingKey = BinaryEncoding.encode(identity.publicKey)
        val agreementKey = BinaryEncoding.encode(agreement.publicKey)
        val challenge = BinaryEncoding.encode(Crypto.randomBytes(32))
        val payload = JsonValue.obj(
            "version" to JsonValue.of(1),
            "hostID" to JsonValue.of(target.hostID),
            "runtimeID" to JsonValue.of(target.runtimeID),
            "signingKey" to JsonValue.of(signingKey),
            "agreementKey" to JsonValue.of(agreementKey),
            "challenge" to JsonValue.of(challenge),
        )
        val signature = identity.sign(canonicalTranscript("miao.control.client.v1", payload))
        hello = ClientHello(1, target.hostID, target.runtimeID, signingKey, agreementKey, challenge, BinaryEncoding.encode(signature))
    }

    fun finish(peer: ServerHello, trustedHostKey: String): SecureSession {
        if (finished) throw ChannelException(ChannelException.Reason.HANDSHAKE_USED)
        finished = true
        validateIdentifier(peer.connectionID)
        if (
            peer.version != 1 || peer.hostID != target.hostID || peer.runtimeID != target.runtimeID ||
            peer.signingKey != trustedHostKey
        ) {
            throw ChannelException(ChannelException.Reason.UNTRUSTED_IDENTITY)
        }
        if (peer.clientChallenge != hello.challenge) throw ChannelException(ChannelException.Reason.CHALLENGE_MISMATCH)
        BinaryEncoding.decodeOrNull(peer.challenge, 32) ?: throw ChannelException(ChannelException.Reason.MALFORMED)
        verifySignature(trustedHostKey, peer.signature, canonicalTranscript("miao.control.server.v1", hello.asJson(), peer.payload()))
        return makeSession(agreement, peer.agreementKey, hello, peer, isClient = true)
    }
}

/** Authorization of the device key must precede acceptance; there is no auto-trust. */
object HostHandshake {
    data class Accepted(val hello: ServerHello, val session: SecureSession)

    fun accept(
        identity: P256SigningKey,
        target: RemoteTarget,
        connectionID: String,
        client: ClientHello,
        trustedDeviceKey: String,
    ): Accepted {
        target.validate()
        validateIdentifier(connectionID)
        if (
            client.version != 1 || client.hostID != target.hostID || client.runtimeID != target.runtimeID ||
            client.signingKey != trustedDeviceKey
        ) {
            throw ChannelException(ChannelException.Reason.UNTRUSTED_IDENTITY)
        }
        BinaryEncoding.decodeOrNull(client.challenge, 32) ?: throw ChannelException(ChannelException.Reason.MALFORMED)
        verifySignature(trustedDeviceKey, client.signature, canonicalTranscript("miao.control.client.v1", client.payload()))

        val agreement = P256AgreementKey.generate()
        val challenge = BinaryEncoding.encode(Crypto.randomBytes(32))
        val payload = JsonValue.obj(
            "version" to JsonValue.of(1),
            "hostID" to JsonValue.of(target.hostID),
            "runtimeID" to JsonValue.of(target.runtimeID),
            "connectionID" to JsonValue.of(connectionID),
            "signingKey" to JsonValue.of(BinaryEncoding.encode(identity.publicKey)),
            "agreementKey" to JsonValue.of(BinaryEncoding.encode(agreement.publicKey)),
            "challenge" to JsonValue.of(challenge),
            "clientChallenge" to JsonValue.of(client.challenge),
        )
        val signature = identity.sign(canonicalTranscript("miao.control.server.v1", client.asJson(), payload))
        val hello = ServerHello(
            version = 1,
            hostID = target.hostID,
            runtimeID = target.runtimeID,
            connectionID = connectionID,
            signingKey = BinaryEncoding.encode(identity.publicKey),
            agreementKey = BinaryEncoding.encode(agreement.publicKey),
            challenge = challenge,
            clientChallenge = client.challenge,
            signature = BinaryEncoding.encode(signature),
        )
        return Accepted(hello, makeSession(agreement, client.agreementKey, client, hello, isClient = false))
    }
}

/** Sequence checks and authenticated cursor advancement are atomic per channel. */
class SecureSession internal constructor(private val sendKey: ByteArray, private val receiveKey: ByteArray) {
    private val mutex = Mutex()
    private var sent = 0L
    private var received = 0L

    suspend fun seal(plaintext: ByteArray): String = mutex.withLock {
        if (plaintext.size > MAX_PLAINTEXT) throw ChannelException(ChannelException.Reason.FRAME_TOO_LARGE)
        if (sent >= MAX_SEQUENCE) throw ChannelException(ChannelException.Reason.EXHAUSTED)
        sent += 1
        val header = byteArrayOf(1) + bigEndian(sent)
        val nonce = ByteArray(4) + bigEndian(sent)
        val sealed = Crypto.aesGcmSeal(sendKey, nonce, plaintext, header)
        BinaryEncoding.encode(header + sealed)
    }

    suspend fun open(encoded: String): ByteArray = mutex.withLock {
        if (encoded.length > MAX_ENCODED) throw ChannelException(ChannelException.Reason.FRAME_TOO_LARGE)
        val packet = BinaryEncoding.decodeOrNull(encoded, null) ?: throw ChannelException(ChannelException.Reason.MALFORMED)
        if (packet.size < 25 || packet[0] != 1.toByte()) throw ChannelException(ChannelException.Reason.MALFORMED)
        val header = packet.copyOfRange(0, 9)
        val sequence = header.copyOfRange(1, 9).fold(0L) { value, byte -> (value shl 8) or (byte.toLong() and 0xFF) }
        if (sequence != received + 1) throw ChannelException(ChannelException.Reason.REPLAY)
        val nonce = ByteArray(4) + header.copyOfRange(1, 9)
        val plaintext = try {
            Crypto.aesGcmOpen(receiveKey, nonce, packet.copyOfRange(9, packet.size), header)
        } catch (_: Exception) {
            throw ChannelException(ChannelException.Reason.MALFORMED)
        }
        received += 1
        plaintext
    }
}

private fun makeSession(
    agreement: P256AgreementKey,
    peerKey: String,
    client: ClientHello,
    host: ServerHello,
    isClient: Boolean,
): SecureSession {
    val peer = BinaryEncoding.decodeOrNull(peerKey, 65) ?: throw ChannelException(ChannelException.Reason.MALFORMED)
    val secret = try {
        agreement.secret(peer)
    } catch (_: MalformedMaterialException) {
        throw ChannelException(ChannelException.Reason.MALFORMED)
    }
    val salt = Crypto.sha256(canonicalTranscript(client.asJson(), host.asJson()))
    fun derive(direction: String): ByteArray =
        Crypto.hkdfSHA256(secret, salt, canonicalTranscript("miao.control.channel.v1", JsonValue.of(direction)), 32)
    val clientKey = derive("client-to-host")
    val hostKey = derive("host-to-client")
    return if (isClient) SecureSession(clientKey, hostKey) else SecureSession(hostKey, clientKey)
}

private fun verifySignature(key: String, signature: String, transcript: ByteArray) {
    val publicKey = BinaryEncoding.decodeOrNull(key, 65) ?: throw ChannelException(ChannelException.Reason.MALFORMED)
    val raw = BinaryEncoding.decodeOrNull(signature, 64) ?: throw ChannelException(ChannelException.Reason.MALFORMED)
    val valid = try {
        Crypto.verify(publicKey, raw, transcript)
    } catch (_: Exception) {
        throw ChannelException(ChannelException.Reason.MALFORMED)
    }
    if (!valid) throw ChannelException(ChannelException.Reason.INVALID_SIGNATURE)
}

internal fun canonicalTranscript(vararg parts: JsonValue): ByteArray =
    CanonicalJson.encodeBytes(JsonValue.Arr(parts.toList()))

internal fun canonicalTranscript(domain: String, vararg parts: JsonValue): ByteArray =
    CanonicalJson.encodeBytes(JsonValue.Arr(listOf(JsonValue.of(domain)) + parts.toList()))

internal fun requiredString(value: JsonValue, key: String): String =
    value[key]?.string ?: throw ChannelException(ChannelException.Reason.MALFORMED)

internal fun requiredInt(value: JsonValue, key: String): Int {
    val number = value[key]?.long ?: throw ChannelException(ChannelException.Reason.MALFORMED)
    if (number < Int.MIN_VALUE || number > Int.MAX_VALUE) throw ChannelException(ChannelException.Reason.MALFORMED)
    return number.toInt()
}

internal fun bigEndian(value: Long): ByteArray = ByteArray(8).also { output ->
    for (index in 0 until 8) output[7 - index] = (value ushr (8 * index)).toByte()
}
