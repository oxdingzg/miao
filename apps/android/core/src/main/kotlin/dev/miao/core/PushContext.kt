package dev.miao.core

data class PushContextBinding(
    val hostID: String,
    val runtimeID: String,
    val grantID: String,
    val grantVersion: Long,
    val deviceID: String,
    val signalID: String,
)

data class PushContextPayload(val sessionID: String, val projectID: String, val expiresAt: Long)

/** Verify the locally pinned host before decrypting; a hint grants no session authority. */
object PushContext {
    private val bindingIdentifier = Regex("^[A-Za-z0-9_-]{16,128}$")
    private val payloadIdentifier = Regex("^[A-Za-z0-9_-]{1,128}$")
    private const val maximumVersion = 9_007_199_254_740_991L
    private const val domainText = "miao.push.context.v1\u0000"

    fun open(
        encoded: String,
        device: P256SigningKey,
        pinnedHostKey: String,
        binding: PushContextBinding,
        now: Long = System.currentTimeMillis(),
    ): PushContextPayload {
        val packet = BinaryEncoding.decodeOrNull(encoded, null)
            ?: throw ChannelException(ChannelException.Reason.MALFORMED)
        if (encoded.length > 4096 || packet.size < 158 || packet.size > 3072 || packet[0] != 1.toByte()) {
            throw ChannelException(ChannelException.Reason.MALFORMED)
        }
        if (device.publicKeyEncoded != binding.deviceID) throw ChannelException(ChannelException.Reason.MALFORMED)
        if (binding.grantVersion !in 1..maximumVersion) throw ChannelException(ChannelException.Reason.MALFORMED)
        for (id in listOf(binding.hostID, binding.runtimeID, binding.grantID, binding.signalID)) {
            if (!bindingIdentifier.matches(id)) throw ChannelException(ChannelException.Reason.MALFORMED)
        }
        val associated = associatedData(binding)
        val domain = domainText.toByteArray(Charsets.UTF_8)
        val body = packet.copyOfRange(0, packet.size - 64)
        val signature = packet.copyOfRange(packet.size - 64, packet.size)
        val hostKey = BinaryEncoding.decodeOrNull(pinnedHostKey, 65)
            ?: throw ChannelException(ChannelException.Reason.MALFORMED)
        val transcript = domain + associated + body
        val signatureValid = try {
            Crypto.verify(hostKey, signature, transcript)
        } catch (_: Exception) {
            false
        }
        if (!signatureValid) throw ChannelException(ChannelException.Reason.INVALID_SIGNATURE)

        val peer = body.copyOfRange(1, 66)
        val secret = try {
            Crypto.ecdh(device.raw, peer)
        } catch (_: Exception) {
            throw ChannelException(ChannelException.Reason.MALFORMED)
        }
        val key = Crypto.hkdfSHA256(secret, Crypto.sha256(associated), domain, 32)
        val nonce = body.copyOfRange(66, 78)
        val plaintext = try {
            Crypto.aesGcmOpen(key, nonce, body.copyOfRange(78, body.size), domain + associated + body.copyOfRange(0, 78))
        } catch (_: Exception) {
            throw ChannelException(ChannelException.Reason.MALFORMED)
        }
        val payload = try {
            CanonicalJson.parse(plaintext)
        } catch (_: JsonParseException) {
            throw ChannelException(ChannelException.Reason.MALFORMED)
        }
        val sessionID = payload["sessionID"]?.string ?: throw ChannelException(ChannelException.Reason.MALFORMED)
        val projectID = payload["projectID"]?.string ?: throw ChannelException(ChannelException.Reason.MALFORMED)
        val expiresAt = payload["expiresAt"]?.long ?: throw ChannelException(ChannelException.Reason.MALFORMED)
        if (expiresAt <= now || expiresAt > now + 600_000) throw ChannelException(ChannelException.Reason.MALFORMED)
        if (!payloadIdentifier.matches(sessionID) || !payloadIdentifier.matches(projectID)) {
            throw ChannelException(ChannelException.Reason.MALFORMED)
        }
        return PushContextPayload(sessionID, projectID, expiresAt)
    }

    internal fun associatedData(binding: PushContextBinding): ByteArray = CanonicalJson.encodeBytes(
        JsonValue.Arr(
            listOf(
                JsonValue.of(binding.hostID),
                JsonValue.of(binding.runtimeID),
                JsonValue.of(binding.grantID),
                JsonValue.of(binding.grantVersion),
                JsonValue.of(binding.deviceID),
                JsonValue.of(binding.signalID),
            ),
        ),
    )
}

data class HubPushNotice(val binding: PushContextBinding, val context: String, val kind: String) {
    fun resolve(device: P256SigningKey, host: AuthorizedHost): PushContextPayload {
        val grant = host.grant
        if (
            binding.hostID != host.host.target.hostID ||
            binding.grantID != grant.id ||
            binding.grantVersion != grant.version.toLong() ||
            binding.deviceID != grant.publicKey ||
            host.expired ||
            grant.revokedAt != null ||
            RemotePermission.Read !in grant.permissions
        ) {
            throw HubAccountException(HubAccountException.Kind.AUTHENTICATION_REQUIRED)
        }
        val payload = PushContext.open(context, device, host.host.publicKey, binding)
        if (payload.sessionID !in grant.sessionIDs && payload.projectID !in grant.projectIDs) {
            throw HubAccountException(HubAccountException.Kind.AUTHENTICATION_REQUIRED)
        }
        return payload
    }

    companion object {
        fun fromJson(value: JsonValue): HubPushNotice {
            val kind = value["kind"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
            val context = value["context"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
            if (kind !in setOf("attention", "completed") || context.length > 4096) {
                throw HubAccountException(HubAccountException.Kind.MALFORMED)
            }
            val binding = PushContextBinding(
                hostID = value["hostID"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
                runtimeID = value["runtimeID"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
                grantID = value["grantID"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
                grantVersion = value["grantVersion"]?.long ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
                deviceID = value["deviceID"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
                signalID = value["signalID"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
            )
            return HubPushNotice(binding, context, kind)
        }
    }
}
