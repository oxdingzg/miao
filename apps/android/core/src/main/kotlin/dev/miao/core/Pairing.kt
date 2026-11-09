package dev.miao.core

import java.net.URI
import java.time.Instant

class PairingException(val reason: Reason) : Exception(reason.name) {
    enum class Reason { INVALID_INVITATION, EXPIRED, INVALID_LABEL, INVALID_GRANT, APPROVAL_UNCERTAIN }
}

enum class RemotePermission(val wire: String) {
    Read("read"),
    Prompt("prompt"),
    PermissionReply("permission.reply"),
    QuestionReply("question.reply"),
    Interrupt("interrupt"),
    SessionCreate("session.create"),
    SessionRename("session.rename"),
    SessionSelection("session.selection"),
    ProviderConfigure("provider.configure"),
    SessionDelete("session.delete"),
    ;

    companion object {
        fun fromWire(value: String): RemotePermission? = entries.firstOrNull { it.wire == value }
    }
}

data class DeviceGrant(
    val id: String,
    val version: Int,
    val publicKey: String,
    val label: String,
    val permissions: List<RemotePermission>,
    val projectIDs: List<String>,
    val sessionIDs: List<String>,
    val createdAt: Long,
    val expiresAt: Long,
    val revokedAt: Long? = null,
) {
    fun validate(deviceKey: String, now: Long = System.currentTimeMillis()) {
        if (!Regex("^[A-Za-z0-9_-]{16,128}$").matches(id)) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if (version <= 0) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if (publicKey != deviceKey) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if (revokedAt != null) throw PairingException(PairingException.Reason.INVALID_GRANT)
        // Metadata is retained for the UI after expiry; only validation uses "now".
        if (expiresAt < 0) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if (now > 0 && expiresAt <= now) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if (label.isEmpty() || label.length > 128) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if (permissions.isEmpty() || permissions.size > 16) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if (projectIDs.size > 128 || sessionIDs.size > 256) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if (projectIDs.isEmpty() && sessionIDs.isEmpty()) throw PairingException(PairingException.Reason.INVALID_GRANT)
        if ((projectIDs + sessionIDs).any { it.isEmpty() || it.length > 128 }) {
            throw PairingException(PairingException.Reason.INVALID_GRANT)
        }
    }

    fun toJson(): JsonValue = JsonValue.obj(
        "id" to JsonValue.of(id),
        "version" to JsonValue.of(version),
        "publicKey" to JsonValue.of(publicKey),
        "label" to JsonValue.of(label),
        "permissions" to JsonValue.Arr(permissions.map { JsonValue.of(it.wire) }),
        "projectIDs" to JsonValue.Arr(projectIDs.map { JsonValue.of(it) }),
        "sessionIDs" to JsonValue.Arr(sessionIDs.map { JsonValue.of(it) }),
        "createdAt" to JsonValue.of(createdAt),
        "expiresAt" to JsonValue.of(expiresAt),
        "revokedAt" to (revokedAt?.let { JsonValue.of(it) } ?: JsonValue.Null),
    )

    companion object {
        fun fromJson(value: JsonValue): DeviceGrant {
            val permissions = (value["permissions"]?.array ?: throw invalid()).mapNotNull { item ->
                item.string?.let { RemotePermission.fromWire(it) }
            }
            if (permissions.size != (value["permissions"]?.array?.size ?: 0)) throw invalid()
            return DeviceGrant(
                id = value["id"]?.string ?: throw invalid(),
                version = value["version"]?.long?.toInt() ?: throw invalid(),
                publicKey = value["publicKey"]?.string ?: throw invalid(),
                label = value["label"]?.string ?: throw invalid(),
                permissions = permissions,
                projectIDs = (value["projectIDs"]?.array ?: throw invalid()).map { it.string ?: throw invalid() },
                sessionIDs = (value["sessionIDs"]?.array ?: throw invalid()).map { it.string ?: throw invalid() },
                createdAt = value["createdAt"]?.long ?: throw invalid(),
                expiresAt = value["expiresAt"]?.long ?: throw invalid(),
                revokedAt = value["revokedAt"]?.let { it.long ?: if (it == JsonValue.Null) null else throw invalid() },
            )
        }

        private fun invalid() = PairingException(PairingException.Reason.INVALID_GRANT)
    }
}

data class PairingInvitation(
    val version: Int,
    val pairingID: String,
    val secret: String,
    val hubURL: String,
    val hostID: String,
    val runtimeID: String,
    val hostPublicKey: String,
    val expiresAt: Long,
) {
    val target: RemoteTarget get() = RemoteTarget(hostID, runtimeID)

    /** Only explicit scans or pastes call this parser; the secret never enters a query or a log. */
    fun validate(now: Long = System.currentTimeMillis(), allowLoopbackHTTP: Boolean = false) {
        if (version != 1) throw PairingException(PairingException.Reason.INVALID_INVITATION)
        if (!Regex("^[A-Za-z0-9_-]{16,128}$").matches(pairingID)) {
            throw PairingException(PairingException.Reason.INVALID_INVITATION)
        }
        if (!Regex("^[a-f0-9]{64}$").matches(secret)) throw PairingException(PairingException.Reason.INVALID_INVITATION)
        if (expiresAt <= now) throw PairingException(PairingException.Reason.EXPIRED)
        target.validate()
        val key = BinaryEncoding.decodeOrNull(hostPublicKey, 65)
            ?: throw PairingException(PairingException.Reason.INVALID_INVITATION)
        try {
            Crypto.pointOf(key)
        } catch (_: MalformedMaterialException) {
            throw PairingException(PairingException.Reason.INVALID_INVITATION)
        }
        val url = try {
            URI(hubURL).toURL()
        } catch (_: Exception) {
            throw PairingException(PairingException.Reason.INVALID_INVITATION)
        }
        try {
            clientEndpoint(url, hostID, allowLoopbackHTTP, runtimeID)
        } catch (_: RemoteRPCException) {
            throw PairingException(PairingException.Reason.INVALID_INVITATION)
        }
    }

    fun claim(label: String, hello: ClientHello): ByteArray {
        if (label.isEmpty() || label.length > 128) throw PairingException(PairingException.Reason.INVALID_LABEL)
        if (!Regex("^[a-f0-9]{64}$").matches(secret)) throw PairingException(PairingException.Reason.INVALID_INVITATION)
        val secretBytes = secret.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val transcript = canonicalTranscript(
            "miao.control.pair.v1",
            JsonValue.of(pairingID),
            JsonValue.of(label),
            hello.asJson(),
        )
        val proof = Crypto.hmacSHA256(secretBytes, transcript).joinToString("") { "%02x".format(it) }
        return CanonicalJson.encodeBytes(
            JsonValue.obj(
                "pairingID" to JsonValue.of(pairingID),
                "label" to JsonValue.of(label),
                "hello" to hello.asJson(),
                "proof" to JsonValue.of(proof),
            ),
        )
    }

    companion object {
        fun parse(uri: String, now: Long = System.currentTimeMillis(), allowLoopbackHTTP: Boolean = false): PairingInvitation {
            if (uri.length > 8192) throw PairingException(PairingException.Reason.INVALID_INVITATION)
            val parsed = try {
                URI(uri)
            } catch (_: Exception) {
                throw PairingException(PairingException.Reason.INVALID_INVITATION)
            }
            if (parsed.scheme != "miao" || parsed.rawAuthority != "pair") {
                throw PairingException(PairingException.Reason.INVALID_INVITATION)
            }
            val path = parsed.rawPath
            if (!path.isNullOrEmpty() || parsed.rawUserInfo != null || parsed.rawQuery != null) {
                throw PairingException(PairingException.Reason.INVALID_INVITATION)
            }
            val fragment = parsed.rawFragment ?: throw PairingException(PairingException.Reason.INVALID_INVITATION)
            if (fragment.length > 6144) throw PairingException(PairingException.Reason.INVALID_INVITATION)
            val payload = BinaryEncoding.decodeOrNull(fragment, null)
                ?: throw PairingException(PairingException.Reason.INVALID_INVITATION)
            val value = try {
                CanonicalJson.parse(payload)
            } catch (_: JsonParseException) {
                throw PairingException(PairingException.Reason.INVALID_INVITATION)
            }
            val invitation = PairingInvitation(
                version = value["version"]?.long?.toInt() ?: throw PairingException(PairingException.Reason.INVALID_INVITATION),
                pairingID = value["pairingID"]?.string ?: throw PairingException(PairingException.Reason.INVALID_INVITATION),
                secret = value["secret"]?.string ?: throw PairingException(PairingException.Reason.INVALID_INVITATION),
                hubURL = value["hubURL"]?.string ?: throw PairingException(PairingException.Reason.INVALID_INVITATION),
                hostID = value["hostID"]?.string ?: throw PairingException(PairingException.Reason.INVALID_INVITATION),
                runtimeID = value["runtimeID"]?.string ?: throw PairingException(PairingException.Reason.INVALID_INVITATION),
                hostPublicKey = value["hostPublicKey"]?.string ?: throw PairingException(PairingException.Reason.INVALID_INVITATION),
                expiresAt = value["expiresAt"]?.long ?: throw PairingException(PairingException.Reason.INVALID_INVITATION),
            )
            invitation.validate(now, allowLoopbackHTTP)
            return invitation
        }
    }
}

data class AuthorizedHost(val host: ApprovedHost, val grant: DeviceGrant, val accountID: String? = null) {
    val id: java.util.UUID get() = host.id
    val expired: Boolean get() = grant.expiresAt <= System.currentTimeMillis()
}

object DeviceFingerprint {
    fun of(publicKey: ByteArray): String = BinaryEncoding.encode(Crypto.sha256(publicKey))
    fun ofUrl(publicKey: ByteArray): String = BinaryEncoding.encode(Crypto.sha256(publicKey))
}

data class PairedConnection(val host: ApprovedHost, val grant: DeviceGrant, val connection: HubConnection)

internal data class PairingNotification(
    val version: Int,
    val type: String,
    val status: String,
    val pairingID: String?,
    val grant: DeviceGrant?,
) {
    companion object {
        fun fromJson(value: JsonValue): PairingNotification {
            val type = value["type"]?.string ?: throw RemoteRPCException.Malformed()
            val status = value["status"]?.string ?: throw RemoteRPCException.Malformed()
            val grant = value["grant"]?.takeUnless { it == JsonValue.Null }?.let { DeviceGrant.fromJson(it) }
            return PairingNotification(
                version = value["version"]?.long?.toInt() ?: throw RemoteRPCException.Malformed(),
                type = type,
                status = status,
                pairingID = value["pairingID"]?.string,
                grant = grant,
            )
        }
    }
}

internal data class RosterNotification(val version: Int, val type: String, val status: String, val grant: DeviceGrant) {
    companion object {
        fun fromJson(value: JsonValue): RosterNotification = RosterNotification(
            version = value["version"]?.long?.toInt() ?: throw RemoteRPCException.Malformed(),
            type = value["type"]?.string ?: throw RemoteRPCException.Malformed(),
            status = value["status"]?.string ?: throw RemoteRPCException.Malformed(),
            grant = value["grant"]?.takeUnless { it == JsonValue.Null }?.let { DeviceGrant.fromJson(it) }
                ?: throw RemoteRPCException.Malformed(),
        )
    }
}

internal fun nowMillis(): Long = Instant.now().toEpochMilli()
