package dev.miao.core

class AccountRosterException(val reason: Reason) : Exception(reason.name) {
    enum class Reason {
        MALFORMED,
        ACCOUNT_MISMATCH,
        STALE_OR_FORKED,
        UNTRUSTED_SIGNER,
        RECIPIENT_MISMATCH,
        EXPIRED,
        NO_PENDING_REQUEST,
    }
}

data class AccountRosterDevice(val publicKey: String, val label: String, val signer: Boolean, val addedAt: Long) {
    fun toJson(): JsonValue = JsonValue.obj(
        "publicKey" to JsonValue.of(publicKey),
        "label" to JsonValue.of(label),
        "signer" to JsonValue.of(signer),
        "addedAt" to JsonValue.of(addedAt),
    )
}

data class AccountRosterPayload(
    val accountID: String,
    val sequence: Long,
    val issuedAt: Long,
    val devices: List<AccountRosterDevice>,
    val version: Int = 1,
) {
    fun toJson(): JsonValue = JsonValue.obj(
        "version" to JsonValue.of(version),
        "accountID" to JsonValue.of(accountID),
        "sequence" to JsonValue.of(sequence),
        "issuedAt" to JsonValue.of(issuedAt),
        "devices" to JsonValue.Arr(devices.map { it.toJson() }),
    )
}

data class AccountRosterAuthority(val accountID: String, val sequence: Long, val digest: String, val signerKeys: List<String>) {
    fun toJson(): JsonValue = JsonValue.obj(
        "accountID" to JsonValue.of(accountID),
        "sequence" to JsonValue.of(sequence),
        "digest" to JsonValue.of(digest),
        "signerKeys" to JsonValue.Arr(signerKeys.map { JsonValue.of(it) }),
    )

    companion object {
        fun fromJson(value: JsonValue): AccountRosterAuthority = AccountRosterAuthority(
            accountID = value["accountID"]?.string ?: throw malformed(),
            sequence = value["sequence"]?.long ?: throw malformed(),
            digest = value["digest"]?.string ?: throw malformed(),
            signerKeys = (value["signerKeys"]?.array ?: throw malformed()).map { it.string ?: throw malformed() },
        )

        private fun malformed() = AccountRosterException(AccountRosterException.Reason.MALFORMED)
    }
}

data class SignedAccountRoster(val roster: AccountRosterPayload, val signature: String, val version: Int = 1) {
    fun toJson(): JsonValue = JsonValue.obj(
        "version" to JsonValue.of(version),
        "roster" to roster.toJson(),
        "signature" to JsonValue.of(signature),
    )

    fun fingerprint(): String {
        validate()
        return BinaryEncoding.encode(Crypto.sha256(canonicalTranscript("miao.control.roster.v1", roster.toJson())))
    }

    fun validate() {
        if (version != 1 || roster.version != 1) throw malformed()
        if (roster.sequence <= 0 || roster.sequence > maximumInteger) throw malformed()
        if (roster.issuedAt < 0 || roster.issuedAt > maximumInteger) throw malformed()
        if (roster.devices.isEmpty() || roster.devices.size > 64) throw malformed()
        rosterIdentifier(roster.accountID)
        if (BinaryEncoding.decodeOrNull(signature, 64) == null) throw malformed()
        var previous = ""
        for (device in roster.devices) {
            if (device.publicKey <= previous) throw malformed()
            if (device.label.isEmpty() || device.label.length > 128) throw malformed()
            if (device.addedAt < 0 || device.addedAt > maximumInteger) throw malformed()
            rosterKey(device.publicKey)
            previous = device.publicKey
        }
    }

    /** A same-sequence reconnect uses its accepted digest, never a new Hub-nominated signer. */
    fun accept(accountID: String, previous: AccountRosterAuthority): AccountRosterAuthority {
        validate()
        if (roster.accountID != accountID || previous.accountID != accountID) {
            throw AccountRosterException(AccountRosterException.Reason.ACCOUNT_MISMATCH)
        }
        val digest = fingerprint()
        if (roster.sequence == previous.sequence) {
            if (previous.sequence <= 0 || digest != previous.digest) {
                throw AccountRosterException(AccountRosterException.Reason.STALE_OR_FORKED)
            }
            return previous
        }
        if (
            roster.sequence <= previous.sequence || previous.sequence < 0 ||
            previous.signerKeys.isEmpty() || previous.signerKeys.size > 64 ||
            previous.signerKeys.toSet().size != previous.signerKeys.size
        ) {
            throw AccountRosterException(AccountRosterException.Reason.STALE_OR_FORKED)
        }
        val transcript = canonicalTranscript("miao.control.roster.v1", roster.toJson())
        val signatureBytes = BinaryEncoding.decode(signature, 64)
        val valid = previous.signerKeys.any { key ->
            runCatching { Crypto.verify(BinaryEncoding.decodeOrNull(key, 65) ?: throw malformed(), signatureBytes, transcript) }
                .getOrDefault(false)
        }
        if (!valid) throw AccountRosterException(AccountRosterException.Reason.UNTRUSTED_SIGNER)
        return AccountRosterAuthority(
            accountID = accountID,
            sequence = roster.sequence,
            digest = digest,
            signerKeys = roster.devices.filter { it.signer }.map { it.publicKey },
        )
    }

    companion object {
        private const val maximumInteger = 9_007_199_254_740_991L

        fun sign(identity: P256SigningKey, roster: AccountRosterPayload): SignedAccountRoster {
            val signature = BinaryEncoding.encode(identity.sign(canonicalTranscript("miao.control.roster.v1", roster.toJson())))
            return SignedAccountRoster(roster, signature)
        }

        /** Strict transport decoding: unknown fields are not silently stripped before hashing. */
        fun decode(bytes: ByteArray): SignedAccountRoster {
            if (bytes.size > 65536) throw malformed()
            val value = try {
                CanonicalJson.parse(bytes)
            } catch (_: JsonParseException) {
                throw malformed()
            }
            return parse(value)
        }

        /** Directory metadata is untrusted until verified against independent local authority. */
        fun hubRecord(bytes: ByteArray, accountID: String): SignedAccountRoster? {
            if (bytes.size > 131072) throw malformed()
            val value = try {
                CanonicalJson.parse(bytes)
            } catch (_: JsonParseException) {
                throw malformed()
            }
            val envelope = rosterObject(value, setOf("roster"))
            if (envelope["roster"] == JsonValue.Null) return null
            val record = rosterObject(envelope["roster"], setOf("accountID", "sequence", "payload", "signature", "digest", "updatedAt"))
            if (rosterString(record["accountID"]) != accountID) {
                throw AccountRosterException(AccountRosterException.Reason.ACCOUNT_MISMATCH)
            }
            val roster = parse(
                JsonValue.obj(
                    "version" to JsonValue.of(1),
                    "roster" to (record["payload"] ?: throw malformed()),
                    "signature" to (record["signature"] ?: throw malformed()),
                ),
            )
            if (roster.roster.accountID != accountID) {
                throw AccountRosterException(AccountRosterException.Reason.ACCOUNT_MISMATCH)
            }
            if (rosterInteger(record["sequence"], 1) != roster.roster.sequence) throw malformed()
            if (rosterString(record["digest"]) != roster.fingerprint()) throw malformed()
            rosterInteger(record["updatedAt"])
            return roster
        }

        private fun parse(input: JsonValue): SignedAccountRoster {
            val signed = rosterObject(input, setOf("version", "roster", "signature"))
            val payload = rosterObject(signed["roster"], setOf("version", "accountID", "sequence", "issuedAt", "devices"))
            val devices = payload["devices"]?.array ?: throw malformed()
            if (devices.isEmpty() || devices.size > 64) throw malformed()
            val decoded = devices.map { value ->
                val device = rosterObject(value, setOf("publicKey", "label", "signer", "addedAt"))
                AccountRosterDevice(
                    publicKey = rosterString(device["publicKey"]),
                    label = rosterString(device["label"]),
                    signer = device["signer"]?.bool ?: throw malformed(),
                    addedAt = rosterInteger(device["addedAt"]),
                )
            }
            val roster = SignedAccountRoster(
                version = rosterInteger(signed["version"]).toInt(),
                roster = AccountRosterPayload(
                    version = rosterInteger(payload["version"]).toInt(),
                    accountID = rosterString(payload["accountID"]),
                    sequence = rosterInteger(payload["sequence"], 1),
                    issuedAt = rosterInteger(payload["issuedAt"]),
                    devices = decoded,
                ),
                signature = rosterString(signed["signature"]),
            )
            roster.validate()
            return roster
        }

        private fun malformed() = AccountRosterException(AccountRosterException.Reason.MALFORMED)
    }
}

data class EndorsedAccountHost(val hostID: String, val publicKey: String) {
    fun toJson(): JsonValue = JsonValue.obj("hostID" to JsonValue.of(hostID), "publicKey" to JsonValue.of(publicKey))
}

const val ROSTER_MAXIMUM_INTEGER = 9_007_199_254_740_991L

internal fun rosterObject(value: JsonValue?, fields: Set<String>): Map<String, JsonValue> {
    val objectMap = value?.objectMap ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    if (objectMap.keys != fields) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    return objectMap
}

internal fun rosterString(value: JsonValue?): String =
    value?.string ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)

internal fun rosterInteger(value: JsonValue?, minimum: Long = 0): Long {
    val number = value?.long ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    if (number < minimum || number > ROSTER_MAXIMUM_INTEGER) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    return number
}

internal fun rosterIdentifier(value: String) {
    if (!Regex("^[A-Za-z0-9_-]{16,128}$").matches(value)) {
        throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    }
}

internal fun rosterKey(value: String): ByteArray {
    val bytes = BinaryEncoding.decodeOrNull(value, 65)
        ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    try {
        Crypto.pointOf(bytes)
    } catch (_: MalformedMaterialException) {
        throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    }
    return bytes
}

internal fun rosterOrigin(value: String, allowLoopbackHTTP: Boolean): String {
    val parsed = try {
        java.net.URI(value)
    } catch (_: Exception) {
        throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    }
    val scheme = parsed.scheme?.lowercase() ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    val host = parsed.host?.lowercase() ?: throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    val local = allowLoopbackHTTP && scheme == "http" && host in setOf("localhost", "127.0.0.1", "::1", "[::1]")
    if (scheme != "https" && !local) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    if (host.isEmpty() || parsed.userInfo != null || parsed.rawQuery != null || parsed.rawFragment != null) {
        throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    }
    if (!parsed.rawPath.isNullOrEmpty() && parsed.rawPath != "/") throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    if (parsed.port !in -1..65535 || parsed.port == 0) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    val port = when {
        parsed.port == -1 -> ""
        scheme == "https" && parsed.port == 443 -> ""
        scheme == "http" && parsed.port == 80 -> ""
        else -> ":" + parsed.port
    }
    val normalized = "$scheme://$host$port"
    if (normalized != value) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
    return normalized
}
