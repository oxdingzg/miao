package dev.miao.core

import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Persists accepted roster authority and independent host pins together, bound to one device identity. */
class AccountEnrollmentStore(directory: File, private val deviceKey: String, private val allowLoopbackHTTP: Boolean = false) {
    private data class State(
        val version: Int = 1,
        val deviceKey: String,
        val accounts: List<AcceptedAccountEnrollment> = emptyList(),
    )

    private val file = File(directory, "account-rosters-v1.json")
    private val mutex = Mutex()
    private var cached: State? = null

    init {
        rosterKey(deviceKey)
    }

    suspend fun account(hubURL: String, accountID: String): AcceptedAccountEnrollment? = mutex.withLock {
        load().accounts.firstOrNull { it.hubURL == hubURL && it.authority.accountID == accountID }
    }

    suspend fun accept(enrollment: AcceptedAccountEnrollment) = mutex.withLock {
        validate(enrollment)
        if (enrollment.roster.roster.devices.none { it.publicKey == deviceKey }) {
            throw AccountRosterException(AccountRosterException.Reason.RECIPIENT_MISMATCH)
        }
        val next = load()
        val previous = next.accounts.firstOrNull {
            it.hubURL == enrollment.hubURL && it.authority.accountID == enrollment.authority.accountID
        }
        if (previous != null) {
            val sameSequence = enrollment.authority.sequence == previous.authority.sequence
            if (enrollment.authority.sequence < previous.authority.sequence || (sameSequence && enrollment.authority.digest != previous.authority.digest)) {
                throw AccountRosterException(AccountRosterException.Reason.STALE_OR_FORKED)
            }
        }
        persist(
            next.copy(
                accounts = next.accounts.filterNot {
                    it.hubURL == enrollment.hubURL && it.authority.accountID == enrollment.authority.accountID
                } + enrollment,
            ),
        )
    }

    suspend fun refresh(roster: SignedAccountRoster, hubURL: String, accountID: String): AcceptedAccountEnrollment = mutex.withLock {
        val next = load()
        val index = next.accounts.indexOfFirst { it.hubURL == hubURL && it.authority.accountID == accountID }
        if (index < 0) throw AccountRosterException(AccountRosterException.Reason.UNTRUSTED_SIGNER)
        val previous = next.accounts[index]
        val authority = roster.accept(accountID, previous.authority)
        if (authority == previous.authority) return@withLock previous
        val updated = AcceptedAccountEnrollment(hubURL, roster, authority, previous.hosts)
        validate(updated)
        // Retain authenticated removal and sequence advancement even when this device is no longer a member.
        persist(next.copy(accounts = next.accounts.toMutableList().also { it[index] = updated }))
        updated
    }

    private fun validate(enrollment: AcceptedAccountEnrollment) {
        rosterOrigin(enrollment.hubURL, allowLoopbackHTTP)
        if (
            enrollment.authority.sequence <= 0 ||
            enrollment.roster.roster.accountID != enrollment.authority.accountID ||
            enrollment.roster.roster.sequence != enrollment.authority.sequence ||
            enrollment.roster.fingerprint() != enrollment.authority.digest ||
            enrollment.authority.signerKeys != enrollment.roster.roster.devices.filter { it.signer }.map { it.publicKey } ||
            enrollment.hosts.isEmpty() || enrollment.hosts.size > 64
        ) {
            throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
        }
        var previous = ""
        for (host in enrollment.hosts) {
            rosterIdentifier(host.hostID)
            rosterKey(host.publicKey)
            if (host.hostID <= previous) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
            previous = host.hostID
        }
    }

    private fun load(): State {
        cached?.let { return it }
        if (!file.exists()) return State(deviceKey = deviceKey)
        if (!file.isFile || file.length() > 2 * 1024 * 1024) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        val value = try {
            CanonicalJson.parse(file.readBytes())
        } catch (_: JsonParseException) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        val state = State(
            version = value["version"]?.long?.toInt() ?: throw invalid(),
            deviceKey = value["deviceKey"]?.string ?: throw invalid(),
            accounts = (value["accounts"]?.array ?: throw invalid()).map { AcceptedAccountEnrollment.fromJson(it) },
        )
        validate(state)
        cached = state
        return state
    }

    private fun validate(state: State) {
        if (
            state.version != 1 || state.deviceKey != deviceKey || state.accounts.size > 16 ||
            state.accounts.map { it.hubURL + "|" + it.authority.accountID }.toSet().size != state.accounts.size
        ) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        state.accounts.forEach { validate(it) }
    }

    private fun persist(next: State) {
        validate(next)
        val bytes = CanonicalJson.encodeBytes(
            JsonValue.obj(
                "version" to JsonValue.of(next.version),
                "deviceKey" to JsonValue.of(next.deviceKey),
                "accounts" to JsonValue.Arr(next.accounts.map { it.toJson() }),
            ),
        )
        if (bytes.size > 2 * 1024 * 1024) throw ClientStateException(ClientStateException.Reason.LIMIT_EXCEEDED)
        val directory = file.parentFile
        if (directory != null && !directory.exists() && !directory.mkdirs()) {
            throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
        val temporary = File(directory, ".account-rosters-" + UUID.randomUUID())
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
        cached = next
    }

    private fun invalid() = ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
}
