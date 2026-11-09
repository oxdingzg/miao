package dev.miao.core

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class AccountEnrollmentRequest(val payload: Payload, val signature: String) {
    data class Payload(
        val version: Int,
        val hubURL: String,
        val accountID: String,
        val publicKey: String,
        val challenge: String,
        val label: String,
        val createdAt: Long,
        val expiresAt: Long,
    ) {
        fun toJson(): JsonValue = JsonValue.obj(
            "version" to JsonValue.of(version),
            "hubURL" to JsonValue.of(hubURL),
            "accountID" to JsonValue.of(accountID),
            "publicKey" to JsonValue.of(publicKey),
            "challenge" to JsonValue.of(challenge),
            "label" to JsonValue.of(label),
            "createdAt" to JsonValue.of(createdAt),
            "expiresAt" to JsonValue.of(expiresAt),
        )
    }

    fun toJson(): JsonValue = JsonValue.obj(
        "payload" to payload.toJson(),
        "signature" to JsonValue.of(signature),
    )

    fun verify(hubURL: String, accountID: String, now: Long = nowMillis(), allowLoopbackHTTP: Boolean = false) {
        val at = enrollmentTimestamp(now)
        if (payload.version != 1 || payload.hubURL != hubURL || payload.accountID != accountID) {
            throw AccountRosterException(AccountRosterException.Reason.ACCOUNT_MISMATCH)
        }
        if (payload.label.isEmpty() || payload.label.length > 128) {
            throw AccountRosterException(AccountRosterException.Reason.ACCOUNT_MISMATCH)
        }
        rosterOrigin(hubURL, allowLoopbackHTTP)
        rosterIdentifier(accountID)
        if (
            payload.createdAt < 0 || payload.createdAt > at + 30_000 || payload.expiresAt <= at ||
            payload.expiresAt <= payload.createdAt || payload.expiresAt - payload.createdAt > 600_000 ||
            payload.expiresAt > ROSTER_MAXIMUM_INTEGER
        ) {
            throw AccountRosterException(AccountRosterException.Reason.EXPIRED)
        }
        if (BinaryEncoding.decodeOrNull(payload.challenge, 32) == null) {
            throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
        }
        val signatureBytes = BinaryEncoding.decodeOrNull(signature, 64)
            ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
        val valid = runCatching {
            Crypto.verify(
                rosterKey(payload.publicKey),
                signatureBytes,
                canonicalTranscript("miao.control.enrollment.v1", payload.toJson()),
            )
        }.getOrDefault(false)
        if (!valid) throw AccountRosterException(AccountRosterException.Reason.UNTRUSTED_SIGNER)
    }

    companion object {
        fun create(
            identity: P256SigningKey,
            hubURL: String,
            accountID: String,
            label: String,
            now: Long = nowMillis(),
            allowLoopbackHTTP: Boolean = false,
        ): AccountEnrollmentRequest {
            val at = enrollmentTimestamp(now)
            if (at > ROSTER_MAXIMUM_INTEGER - 600_000) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            val payload = Payload(
                version = 1,
                hubURL = rosterOrigin(hubURL, allowLoopbackHTTP),
                accountID = accountID,
                publicKey = identity.publicKeyEncoded,
                challenge = BinaryEncoding.encode(Crypto.randomBytes(32)),
                label = label,
                createdAt = at,
                expiresAt = at + 600_000,
            )
            val signature = BinaryEncoding.encode(
                identity.sign(canonicalTranscript("miao.control.enrollment.v1", payload.toJson())),
            )
            val request = AccountEnrollmentRequest(payload, signature)
            request.verify(hubURL, accountID, now, allowLoopbackHTTP)
            return request
        }

        fun decode(bytes: ByteArray): AccountEnrollmentRequest {
            if (bytes.size > 8192) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            val value = try {
                CanonicalJson.parse(bytes)
            } catch (_: JsonParseException) {
                throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            }
            val signed = rosterObject(value, setOf("payload", "signature"))
            val payload = rosterObject(
                signed["payload"],
                setOf("version", "hubURL", "accountID", "publicKey", "challenge", "label", "createdAt", "expiresAt"),
            )
            return AccountEnrollmentRequest(
                payload = Payload(
                    version = rosterInteger(payload["version"]).toInt(),
                    hubURL = rosterString(payload["hubURL"]),
                    accountID = rosterString(payload["accountID"]),
                    publicKey = rosterString(payload["publicKey"]),
                    challenge = rosterString(payload["challenge"]),
                    label = rosterString(payload["label"]),
                    createdAt = rosterInteger(payload["createdAt"]),
                    expiresAt = rosterInteger(payload["expiresAt"]),
                ),
                signature = rosterString(signed["signature"]),
            )
        }
    }
}

data class AccountHostEndorsement(val payload: Payload, val signature: String) {
    data class Payload(
        val version: Int,
        val hubURL: String,
        val accountID: String,
        val deviceKey: String,
        val challenge: String,
        val hosts: List<EndorsedAccountHost>,
    ) {
        fun toJson(): JsonValue = JsonValue.obj(
            "version" to JsonValue.of(version),
            "hubURL" to JsonValue.of(hubURL),
            "accountID" to JsonValue.of(accountID),
            "deviceKey" to JsonValue.of(deviceKey),
            "challenge" to JsonValue.of(challenge),
            "hosts" to JsonValue.Arr(hosts.map { it.toJson() }),
        )
    }

    fun toJson(): JsonValue = JsonValue.obj(
        "payload" to payload.toJson(),
        "signature" to JsonValue.of(signature),
    )

    fun validate(request: AccountEnrollmentRequest) {
        if (
            payload.version != 1 || payload.hubURL != request.payload.hubURL ||
            payload.accountID != request.payload.accountID || payload.deviceKey != request.payload.publicKey ||
            payload.challenge != request.payload.challenge || payload.hosts.isEmpty() || payload.hosts.size > 64
        ) {
            throw AccountRosterException(AccountRosterException.Reason.RECIPIENT_MISMATCH)
        }
        var previous = ""
        for (host in payload.hosts) {
            rosterIdentifier(host.hostID)
            rosterKey(host.publicKey)
            if (host.hostID <= previous) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            previous = host.hostID
        }
    }

    companion object {
        fun parse(value: JsonValue?): AccountHostEndorsement {
            val signed = rosterObject(value, setOf("payload", "signature"))
            val payload = rosterObject(
                signed["payload"],
                setOf("version", "hubURL", "accountID", "deviceKey", "challenge", "hosts"),
            )
            val hosts = payload["hosts"]?.array ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            if (hosts.isEmpty() || hosts.size > 64) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            return AccountHostEndorsement(
                payload = Payload(
                    version = rosterInteger(payload["version"]).toInt(),
                    hubURL = rosterString(payload["hubURL"]),
                    accountID = rosterString(payload["accountID"]),
                    deviceKey = rosterString(payload["deviceKey"]),
                    challenge = rosterString(payload["challenge"]),
                    hosts = hosts.map { host ->
                        val value = rosterObject(host, setOf("hostID", "publicKey"))
                        EndorsedAccountHost(rosterString(value["hostID"]), rosterString(value["publicKey"]))
                    },
                ),
                signature = rosterString(signed["signature"]),
            )
        }
    }
}

data class AcceptedAccountEnrollment(
    val hubURL: String,
    val roster: SignedAccountRoster,
    val authority: AccountRosterAuthority,
    val hosts: List<EndorsedAccountHost>,
) {
    fun toJson(): JsonValue = JsonValue.obj(
        "hubURL" to JsonValue.of(hubURL),
        "roster" to roster.toJson(),
        "authority" to authority.toJson(),
        "hosts" to JsonValue.Arr(hosts.map { it.toJson() }),
    )

    companion object {
        fun fromJson(value: JsonValue): AcceptedAccountEnrollment = AcceptedAccountEnrollment(
            hubURL = value["hubURL"]?.string ?: throw malformed(),
            roster = SignedAccountRoster.decode(CanonicalJson.encodeBytes(value["roster"] ?: throw malformed())),
            authority = AccountRosterAuthority.fromJson(value["authority"] ?: throw malformed()),
            hosts = (value["hosts"]?.array ?: throw malformed()).map {
                EndorsedAccountHost(
                    hostID = it["hostID"]?.string ?: throw malformed(),
                    publicKey = it["publicKey"]?.string ?: throw malformed(),
                )
            },
        )

        /** Explicitly selected live computer pairings supply the initial independent host pins. */
        fun root(
            identity: P256SigningKey,
            hubURL: String,
            accountID: String,
            paired: List<AuthorizedHost>,
            existing: SignedAccountRoster? = null,
            now: Long = nowMillis(),
            allowLoopbackHTTP: Boolean = false,
        ): AcceptedAccountEnrollment {
            rosterOrigin(hubURL, allowLoopbackHTTP)
            val key = identity.publicKeyEncoded
            val pins = mutableMapOf<String, String>()
            for (record in paired) {
                if (record.host.hubURL != hubURL || record.grant.publicKey != key || record.expired) continue
                record.grant.validate(key, now)
                if (record.host.grantID != record.grant.id || record.host.grantVersion != record.grant.version) {
                    throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
                }
                rosterKey(record.host.publicKey)
                val previous = pins[record.host.target.hostID]
                if (previous != null && previous != record.host.publicKey) {
                    throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
                }
                pins[record.host.target.hostID] = record.host.publicKey
            }
            if (pins.isEmpty() || pins.size > 64) throw AccountRosterException(AccountRosterException.Reason.UNTRUSTED_SIGNER)
            val roster = existing ?: SignedAccountRoster.sign(
                identity = identity,
                roster = AccountRosterPayload(
                    accountID = accountID,
                    sequence = 1,
                    issuedAt = enrollmentTimestamp(now),
                    devices = listOf(AccountRosterDevice(key, "账号签名设备", true, enrollmentTimestamp(now))),
                ),
            )
            val authority = roster.accept(
                accountID = accountID,
                previous = AccountRosterAuthority(accountID, sequence = 0, digest = "", signerKeys = listOf(key)),
            )
            if (roster.roster.devices.none { it.publicKey == key && it.signer }) {
                throw AccountRosterException(AccountRosterException.Reason.UNTRUSTED_SIGNER)
            }
            return AcceptedAccountEnrollment(
                hubURL = hubURL,
                roster = roster,
                authority = authority,
                hosts = pins.keys.sorted().map { EndorsedAccountHost(it, pins.getValue(it)) },
            )
        }

        private fun malformed() = AccountRosterException(AccountRosterException.Reason.MALFORMED)
    }
}

data class AccountEnrollmentApproval(val version: Int, val roster: SignedAccountRoster, val endorsement: AccountHostEndorsement) {
    fun toJson(): JsonValue = JsonValue.obj(
        "version" to JsonValue.of(version),
        "roster" to roster.toJson(),
        "endorsement" to endorsement.toJson(),
    )

    /** trustedSignerKey is obtained out of band, not from a Hub roster or directory response. */
    fun accept(
        pending: AccountEnrollmentRequest,
        trustedSignerKey: String,
        now: Long = nowMillis(),
        allowLoopbackHTTP: Boolean = false,
    ): AcceptedAccountEnrollment {
        if (version != 1) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
        pending.verify(pending.payload.hubURL, pending.payload.accountID, now, allowLoopbackHTTP)
        val accepted = roster.accept(
            accountID = pending.payload.accountID,
            previous = AccountRosterAuthority(pending.payload.accountID, sequence = 0, digest = "", signerKeys = listOf(trustedSignerKey)),
        )
        if (roster.roster.devices.none { it.publicKey == pending.payload.publicKey }) {
            throw AccountRosterException(AccountRosterException.Reason.RECIPIENT_MISMATCH)
        }
        endorsement.validate(pending)
        val signature = BinaryEncoding.decodeOrNull(endorsement.signature, 64)
            ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
        val valid = runCatching {
            Crypto.verify(
                rosterKey(trustedSignerKey),
                signature,
                canonicalTranscript("miao.control.host-endorsement.v1", endorsement.payload.toJson()),
            )
        }.getOrDefault(false)
        if (!valid) throw AccountRosterException(AccountRosterException.Reason.UNTRUSTED_SIGNER)
        return AcceptedAccountEnrollment(
            hubURL = endorsement.payload.hubURL,
            roster = roster,
            authority = accepted,
            hosts = endorsement.payload.hosts,
        )
    }

    companion object {
        fun decode(bytes: ByteArray): AccountEnrollmentApproval {
            if (bytes.size > 131072) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            val value = try {
                CanonicalJson.parse(bytes)
            } catch (_: JsonParseException) {
                throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            }
            val signed = rosterObject(value, setOf("version", "roster", "endorsement"))
            if (rosterInteger(signed["version"]) != 1L) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            val roster = SignedAccountRoster.decode(CanonicalJson.encodeBytes(signed["roster"] ?: throw malformed()))
            return AccountEnrollmentApproval(1, roster, AccountHostEndorsement.parse(signed["endorsement"]))
        }

        fun approve(
            identity: P256SigningKey,
            request: AccountEnrollmentRequest,
            hubURL: String,
            current: SignedAccountRoster,
            authority: AccountRosterAuthority,
            pairedHosts: List<EndorsedAccountHost>,
            now: Long = nowMillis(),
            allowLoopbackHTTP: Boolean = false,
        ): AccountEnrollmentApproval {
            request.verify(hubURL, authority.accountID, now, allowLoopbackHTTP)
            val key = identity.publicKeyEncoded
            if (
                current.roster.accountID != authority.accountID ||
                current.roster.sequence != authority.sequence ||
                current.fingerprint() != authority.digest ||
                key !in authority.signerKeys ||
                current.roster.devices.none { it.publicKey == key && it.signer }
            ) {
                throw AccountRosterException(AccountRosterException.Reason.UNTRUSTED_SIGNER)
            }
            val devices = current.roster.devices.toMutableList()
            if (devices.none { it.publicKey == request.payload.publicKey }) {
                devices += AccountRosterDevice(
                    publicKey = request.payload.publicKey,
                    label = request.payload.label,
                    signer = false,
                    addedAt = enrollmentTimestamp(now),
                )
            }
            devices.sortBy { it.publicKey }
            val roster = SignedAccountRoster.sign(
                identity = identity,
                roster = AccountRosterPayload(
                    accountID = authority.accountID,
                    sequence = authority.sequence + 1,
                    issuedAt = enrollmentTimestamp(now),
                    devices = devices,
                ),
            )
            val payload = AccountHostEndorsement.Payload(
                version = 1,
                hubURL = hubURL,
                accountID = authority.accountID,
                deviceKey = request.payload.publicKey,
                challenge = request.payload.challenge,
                hosts = pairedHosts,
            )
            AccountHostEndorsement(payload, "").validate(request)
            val signature = BinaryEncoding.encode(
                identity.sign(canonicalTranscript("miao.control.host-endorsement.v1", payload.toJson())),
            )
            return AccountEnrollmentApproval(1, roster, AccountHostEndorsement(payload, signature))
        }

        private fun malformed() = AccountRosterException(AccountRosterException.Reason.MALFORMED)
    }
}

/** Nonce consumption, replacement and cancellation are atomic. */
class AccountEnrollment(private val identity: P256SigningKey) {
    private val mutex = Mutex()
    private var pending: AccountEnrollmentRequest? = null

    suspend fun cancel() = mutex.withLock { pending = null }

    suspend fun begin(
        hubURL: String,
        accountID: String,
        label: String,
        now: Long = nowMillis(),
        allowLoopbackHTTP: Boolean = false,
    ): ByteArray = mutex.withLock {
        pending = null
        val request = AccountEnrollmentRequest.create(identity, hubURL, accountID, label, now, allowLoopbackHTTP)
        pending = request
        CanonicalJson.encodeBytes(request.toJson())
    }

    suspend fun receive(
        bytes: ByteArray,
        trustedSignerKey: String,
        now: Long = nowMillis(),
        allowLoopbackHTTP: Boolean = false,
    ): AcceptedAccountEnrollment = mutex.withLock {
        val request = pending ?: throw AccountRosterException(AccountRosterException.Reason.NO_PENDING_REQUEST)
        val accepted = AccountEnrollmentApproval.decode(bytes)
            .accept(request, trustedSignerKey, now, allowLoopbackHTTP)
        pending = null
        accepted
    }
}

internal fun enrollmentTimestamp(value: Long): Long {
    if (value < 0 || value > ROSTER_MAXIMUM_INTEGER) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    return value
}
