package dev.miao.core

import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class PairingAttempt(
    val id: String,
    val hubURL: String,
    val target: RemoteTarget,
    val hostPublicKey: String,
    val createdAt: Long,
)

/**
 * Contains public trust/authorization metadata only, never an invitation secret
 * or signing key. The trust anchor is persisted before a claim is transmitted,
 * so an uncertain approval can be reconciled later.
 */
class HostRegistry(directory: File, private val deviceKey: String, private val allowLoopbackHTTP: Boolean = false) {
    private data class HiddenAccountHost(val hubURL: String, val accountID: String?, val hostID: String)

    private data class State(
        val version: Int = 1,
        val deviceKey: String,
        val hosts: List<AuthorizedHost> = emptyList(),
        val attempts: List<PairingAttempt> = emptyList(),
        val hiddenAccountHosts: List<HiddenAccountHost> = emptyList(),
    )

    private val file = File(directory, "hosts-v1.json")
    private val mutex = Mutex()
    private var state: State? = null

    suspend fun hosts(): List<AuthorizedHost> = mutex.withLock { load().hosts }

    suspend fun attempts(): List<PairingAttempt> = mutex.withLock { load().attempts }

    suspend fun snapshot(): Pair<List<AuthorizedHost>, List<PairingAttempt>> = mutex.withLock {
        val value = load()
        value.hosts to value.attempts
    }

    suspend fun begin(invitation: PairingInvitation) = mutex.withLock {
        invitation.validate(allowLoopbackHTTP = allowLoopbackHTTP)
        val next = load()
        persist(
            next.copy(
                attempts = next.attempts.filterNot { it.id == invitation.pairingID } + PairingAttempt(
                    id = invitation.pairingID,
                    hubURL = invitation.hubURL,
                    target = invitation.target,
                    hostPublicKey = invitation.hostPublicKey,
                    createdAt = nowMillis(),
                ),
            ),
        )
    }

    suspend fun approve(host: ApprovedHost, grant: DeviceGrant, pairingID: String) = mutex.withLock {
        grant.validate(deviceKey)
        if (host.grantID != grant.id || host.grantVersion != grant.version) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
        val next = load()
        val attempt = next.attempts.firstOrNull { it.id == pairingID }
            ?: throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        if (attempt.target != host.target || attempt.hostPublicKey != host.publicKey || attempt.hubURL != host.hubURL) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
        persist(
            next.copy(
                hosts = next.hosts.filterNot { it.host.target.hostID == host.target.hostID && it.grant.id == grant.id } +
                    AuthorizedHost(host, grant),
                attempts = next.attempts.filterNot { it.id == pairingID },
                hiddenAccountHosts = next.hiddenAccountHosts.filterNot {
                    it.hubURL == host.hubURL && it.hostID == host.target.hostID
                },
            ),
        )
    }

    suspend fun admitAuto(host: ApprovedHost, grant: DeviceGrant) = mutex.withLock {
        grant.validate(deviceKey)
        if (host.grantID != grant.id || host.grantVersion != grant.version || host.label.isEmpty() || host.label.length > 128) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
        val next = load()
        if (next.hiddenAccountHosts.any { it.hubURL == host.hubURL && it.hostID == host.target.hostID }) return@withLock
        persist(
            next.copy(
                hosts = next.hosts.filterNot {
                    it.host.hubURL == host.hubURL && it.host.target.hostID == host.target.hostID && it.grant.id == grant.id
                } + AuthorizedHost(host, grant),
            ),
        )
    }

    suspend fun admitSignedIn(host: ApprovedHost, grant: DeviceGrant, accountID: String) = mutex.withLock {
        grant.validate(deviceKey)
        if (accountID.isEmpty() || host.grantID != grant.id || host.grantVersion != grant.version) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
        val next = load()
        if (isHidden(next, host.hubURL, accountID, host.target.hostID)) return@withLock
        persist(
            next.copy(
                hosts = next.hosts.filterNot {
                    it.host.hubURL == host.hubURL &&
                        (it.host.target == host.target || (it.accountID == null && it.host.target.hostID == host.target.hostID))
                } + AuthorizedHost(host, grant, accountID),
            ),
        )
    }

    suspend fun synchronizeAccount(hubURL: String, accountID: String, directory: List<HubDirectoryHost>) = mutex.withLock {
        val next = load()
        val remaining = next.hosts.filterNot { record ->
            if (record.accountID != accountID || record.host.hubURL != hubURL) return@filterNot false
            val known = directory.filter { it.hostID == record.host.target.hostID }
            if (known.any { it.revokedAt != null }) return@filterNot true
            // Keep the view stable during a transient relay outage: replace an old
            // runtime only when the directory advertises a live replacement.
            known.any { it.online } && known.none { it.runtimeID == record.host.target.runtimeID && it.online }
        }
        if (remaining != next.hosts) persist(next.copy(hosts = remaining))
    }

    suspend fun rename(directory: List<HubDirectoryHost>, hubURL: String) = mutex.withLock {
        val next = load()
        val hosts = next.hosts.map { record ->
            if (record.host.hubURL != hubURL) return@map record
            val entry = directory.firstOrNull {
                it.hostID == record.host.target.hostID && it.runtimeID == record.host.target.runtimeID &&
                    it.revokedAt == null && it.name.isNotEmpty()
            } ?: return@map record
            if (record.host.label == entry.name) return@map record
            record.copy(host = record.host.copy(label = entry.name))
        }
        if (hosts != next.hosts) persist(next.copy(hosts = hosts))
    }

    suspend fun admitAccount(host: ApprovedHost, grant: DeviceGrant, enrollment: AcceptedAccountEnrollment) = mutex.withLock {
        grant.validate(deviceKey)
        if (
            host.hubURL != enrollment.hubURL ||
            host.grantID != grant.id ||
            host.grantVersion != grant.version ||
            enrollment.roster.roster.devices.none { it.publicKey == deviceKey } ||
            enrollment.hosts.none { it.hostID == host.target.hostID && it.publicKey == host.publicKey } ||
            enrollment.roster.fingerprint() != enrollment.authority.digest
        ) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
        val next = load()
        persist(
            next.copy(
                hosts = next.hosts.filterNot {
                    it.host.hubURL == host.hubURL && it.host.target.hostID == host.target.hostID && it.grant.id == grant.id
                } + AuthorizedHost(host, grant),
            ),
        )
    }

    suspend fun forget(id: UUID, accountID: String? = null) = mutex.withLock {
        val next = load()
        val record = next.hosts.firstOrNull { it.id == id }
        val hidden = record?.let {
            HiddenAccountHost(it.host.hubURL, accountID ?: it.accountID, it.host.target.hostID)
        }
        persist(
            next.copy(
                hosts = next.hosts.filterNot { it.id == id },
                hiddenAccountHosts = if (hidden == null || next.hiddenAccountHosts.contains(hidden)) {
                    next.hiddenAccountHosts
                } else {
                    next.hiddenAccountHosts + hidden
                },
            ),
        )
    }

    suspend fun isAccountHostHidden(hubURL: String, accountID: String, hostID: String): Boolean = mutex.withLock {
        isHidden(load(), hubURL, accountID, hostID)
    }

    suspend fun restoreAccountHosts(hubURL: String, accountID: String) = mutex.withLock {
        val next = load()
        persist(
            next.copy(
                hiddenAccountHosts = next.hiddenAccountHosts.filterNot {
                    it.hubURL == hubURL && (it.accountID == null || it.accountID == accountID)
                },
            ),
        )
    }

    suspend fun forgetAttempt(id: String) = mutex.withLock {
        val next = load()
        persist(next.copy(attempts = next.attempts.filterNot { it.id == id }))
    }

    private fun isHidden(state: State, hubURL: String, accountID: String, hostID: String): Boolean =
        state.hiddenAccountHosts.any {
            it.hubURL == hubURL && it.hostID == hostID && (it.accountID == null || it.accountID == accountID)
        }

    private fun load(): State {
        state?.let { return it }
        if (!file.exists()) return State(deviceKey = deviceKey)
        if (!file.isFile || file.length() > 16 * 1024 * 1024) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        val saved = decode(file.readBytes())
        validate(saved)
        state = saved
        return saved
    }

    private fun validate(next: State) {
        if (next.version != 1 || next.deviceKey != deviceKey) {
            throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
        }
        if (
            next.hosts.size > 64 || next.attempts.size > 8 ||
            next.hosts.map { it.id }.toSet().size != next.hosts.size ||
            next.attempts.map { it.id }.toSet().size != next.attempts.size
        ) {
            throw ClientStateException(ClientStateException.Reason.LIMIT_EXCEEDED)
        }
        for (record in next.hosts) {
            // Expired metadata stays for the UI but never becomes an active grant.
            record.grant.validate(deviceKey, now = -1)
            if (record.host.grantID != record.grant.id || record.host.grantVersion != record.grant.version) {
                throw ClientStateException(ClientStateException.Reason.SCOPE_MISMATCH)
            }
            record.host.target.validate()
            if (BinaryEncoding.decodeOrNull(record.host.publicKey, 65) == null) {
                throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
            }
            runCatching {
                clientEndpoint(java.net.URI(record.host.hubURL).toURL(), record.host.target.hostID, allowLoopbackHTTP)
            }.getOrElse { throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE) }
        }
        for (attempt in next.attempts) {
            if (!Regex("^[A-Za-z0-9_-]{16,128}$").matches(attempt.id)) {
                throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
            }
            attempt.target.validate()
            if (BinaryEncoding.decodeOrNull(attempt.hostPublicKey, 65) == null) {
                throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
            }
            runCatching {
                clientEndpoint(java.net.URI(attempt.hubURL).toURL(), attempt.target.hostID, allowLoopbackHTTP)
            }.getOrElse { throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE) }
        }
    }

    private fun persist(next: State) {
        validate(next)
        val bytes = encode(next)
        if (bytes.size > 16 * 1024 * 1024) throw ClientStateException(ClientStateException.Reason.LIMIT_EXCEEDED)
        val directory = file.parentFile
        if (directory != null && !directory.exists() && !directory.mkdirs()) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        val temporary = File(directory, ".hosts-" + UUID.randomUUID())
        try {
            FileOutputStream(temporary).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            if (!temporary.renameTo(file)) {
                file.delete()
                if (!temporary.renameTo(file)) throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
        state = next
    }

    private fun encode(state: State): ByteArray = CanonicalJson.encodeBytes(
        JsonValue.obj(
            "version" to JsonValue.of(state.version),
            "deviceKey" to JsonValue.of(state.deviceKey),
            "hosts" to JsonValue.Arr(state.hosts.map { hostJson(it) }),
            "attempts" to JsonValue.Arr(state.attempts.map { attemptJson(it) }),
            "hiddenAccountHosts" to JsonValue.Arr(
                state.hiddenAccountHosts.map {
                    JsonValue.obj(
                        "hubURL" to JsonValue.of(it.hubURL),
                        "accountID" to (it.accountID?.let { id -> JsonValue.of(id) } ?: JsonValue.Null),
                        "hostID" to JsonValue.of(it.hostID),
                    )
                },
            ),
        ),
    )

    private fun decode(bytes: ByteArray): State {
        val value = try {
            CanonicalJson.parse(bytes)
        } catch (_: JsonParseException) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        return State(
            version = value["version"]?.long?.toInt() ?: throw invalid(),
            deviceKey = value["deviceKey"]?.string ?: throw invalid(),
            hosts = (value["hosts"]?.array ?: throw invalid()).map { hostFromJson(it) },
            attempts = (value["attempts"]?.array ?: throw invalid()).map { attemptFromJson(it) },
            hiddenAccountHosts = (value["hiddenAccountHosts"]?.array ?: emptyList()).map {
                HiddenAccountHost(
                    hubURL = it["hubURL"]?.string ?: throw invalid(),
                    accountID = it["accountID"]?.string,
                    hostID = it["hostID"]?.string ?: throw invalid(),
                )
            },
        )
    }

    private fun hostJson(record: AuthorizedHost): JsonValue = JsonValue.obj(
        "host" to JsonValue.obj(
            "id" to JsonValue.of(record.host.id.toString()),
            "label" to JsonValue.of(record.host.label),
            "hubURL" to JsonValue.of(record.host.hubURL),
            "target" to JsonValue.obj(
                "hostID" to JsonValue.of(record.host.target.hostID),
                "runtimeID" to JsonValue.of(record.host.target.runtimeID),
            ),
            "publicKey" to JsonValue.of(record.host.publicKey),
            "grantID" to JsonValue.of(record.host.grantID),
            "grantVersion" to JsonValue.of(record.host.grantVersion),
        ),
        "grant" to record.grant.toJson(),
        "accountID" to (record.accountID?.let { JsonValue.of(it) } ?: JsonValue.Null),
    )

    private fun hostFromJson(value: JsonValue): AuthorizedHost {
        val host = value["host"] ?: throw invalid()
        return AuthorizedHost(
            host = ApprovedHost.create(
                id = runCatching { UUID.fromString(host["id"]?.string ?: throw invalid()) }.getOrElse { throw invalid() },
                label = host["label"]?.string ?: throw invalid(),
                hubURL = host["hubURL"]?.string ?: throw invalid(),
                target = RemoteTarget(
                    host["target"]?.get("hostID")?.string ?: throw invalid(),
                    host["target"]?.get("runtimeID")?.string ?: throw invalid(),
                ),
                publicKey = host["publicKey"]?.string ?: throw invalid(),
                grantID = host["grantID"]?.string ?: throw invalid(),
                grantVersion = host["grantVersion"]?.long?.toInt() ?: throw invalid(),
            ),
            grant = DeviceGrant.fromJson(value["grant"] ?: throw invalid()),
            accountID = value["accountID"]?.string,
        )
    }

    private fun attemptJson(attempt: PairingAttempt): JsonValue = JsonValue.obj(
        "id" to JsonValue.of(attempt.id),
        "hubURL" to JsonValue.of(attempt.hubURL),
        "target" to JsonValue.obj(
            "hostID" to JsonValue.of(attempt.target.hostID),
            "runtimeID" to JsonValue.of(attempt.target.runtimeID),
        ),
        "hostPublicKey" to JsonValue.of(attempt.hostPublicKey),
        "createdAt" to JsonValue.of(attempt.createdAt),
    )

    private fun attemptFromJson(value: JsonValue): PairingAttempt = PairingAttempt(
        id = value["id"]?.string ?: throw invalid(),
        hubURL = value["hubURL"]?.string ?: throw invalid(),
        target = RemoteTarget(
            value["target"]?.get("hostID")?.string ?: throw invalid(),
            value["target"]?.get("runtimeID")?.string ?: throw invalid(),
        ),
        hostPublicKey = value["hostPublicKey"]?.string ?: throw invalid(),
        createdAt = value["createdAt"]?.long ?: 0,
    )

    private fun invalid() = ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
}
