package dev.miao.core

import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

interface CredentialStorage {
    fun load(): String?
    fun save(credential: String)
    fun remove()
}

class InMemoryCredentialStorage(private var credential: String? = null) : CredentialStorage {
    override fun load(): String? = credential
    override fun save(credential: String) {
        this.credential = credential
    }

    override fun remove() {
        credential = null
    }
}

data class HubDirectoryHost(
    val hostID: String,
    val name: String,
    val publicKey: String,
    val createdAt: Long,
    val revokedAt: Long?,
    val online: Boolean,
    val runtimeID: String?,
) {
    val id: String get() = hostID + ":" + (runtimeID ?: "offline")

    companion object {
        fun fromJson(value: JsonValue): HubDirectoryHost {
            val online = value["online"]?.bool ?: false
            val runtimeID = value["runtimeID"]?.string
            if (!online && runtimeID != null) throw HubAccountException(HubAccountException.Kind.MALFORMED)
            return HubDirectoryHost(
                hostID = value["hostID"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
                name = value["name"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
                publicKey = value["publicKey"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED),
                createdAt = value["createdAt"]?.long ?: 0,
                revokedAt = value["revokedAt"]?.takeUnless { it == JsonValue.Null }?.long,
                online = online,
                runtimeID = runtimeID,
            )
        }
    }
}

class HubAccountException(val kind: Kind, val status: Int = 0) : Exception(kind.name) {
    enum class Kind { INVALID_ENDPOINT, INVALID_CREDENTIALS, AUTHENTICATION_REQUIRED, REJECTED, MALFORMED, SUPERSEDED, STORAGE }
}

/**
 * Account credentials authorize the opaque relay; the Agent's device grant still
 * authorizes every RPC. A generation fences stale responses after a sign-out or a
 * replacement sign-in.
 */
class HubAccount(
    origin: String,
    private val credentialStorage: CredentialStorage,
    private val allowLoopbackHTTP: Boolean = false,
) {
    val origin: String = normalizeOrigin(origin, allowLoopbackHTTP)
    private val mutex = Mutex()
    private var login: String? = null
    private var pendingLogout: String? = null
    private var access: Pair<String, Long>? = null
    private var generation = 0L
    private var verifiedAccount: Pair<Long, String>? = null

    suspend fun restore(): Boolean = mutex.withLock {
        if (login != null) return true
        val credential = credentialStorage.load() ?: return false
        if (!validCredential(credential)) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        login = credential
        generation += 1
        true
    }

    suspend fun signIn(email: String, password: String) {
        if (email.isEmpty() || email.length > 320 || password.isEmpty() || password.length > 1024) {
            throw HubAccountException(HubAccountException.Kind.INVALID_CREDENTIALS)
        }
        if (pendingLogout != null) signOut()
        val expected = mutex.withLock { generation += 1; generation }
        val body = CanonicalJson.encodeBytes(JsonValue.obj("email" to JsonValue.of(email), "password" to JsonValue.of(password)))
        val response = send("/api/auth/sign-in/email", body = body)
        val credential = response.headers["set-auth-token"] ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        if (!validCredential(credential)) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        if (mutex.withLock { generation } != expected) {
            runCatching { send("/api/auth/sign-out", credential = credential, body = "{}".toByteArray()) }
            throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        }
        credentialStorage.save(credential)
        mutex.withLock {
            login = credential
            access = null
        }
    }

    suspend fun oauthAuthorizeURL(provider: String, callbackURL: String): String {
        if (provider != "github" && provider != "google") throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT)
        val body = CanonicalJson.encodeBytes(
            JsonValue.obj("provider" to JsonValue.of(provider), "callbackURL" to JsonValue.of(callbackURL)),
        )
        val response = send("/api/auth/sign-in/social", body = body)
        val url = response.json()["url"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        if (!url.startsWith("https://")) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        return url
    }

    suspend fun signInWithOAuth(code: String) {
        if (code.isEmpty() || code.length > 512) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        if (pendingLogout != null) signOut()
        val expected = mutex.withLock { generation += 1; generation }
        val body = CanonicalJson.encodeBytes(
            JsonValue.obj("code" to JsonValue.of(code), "client" to JsonValue.of("android")),
        )
        val response = send("/api/auth/exchange", body = body)
        val token = response.json()["token"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        if (!validCredential(token)) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        credentialStorage.save(token)
        mutex.withLock {
            login = token
            access = token to (System.currentTimeMillis() + 600_000)
        }
    }

    suspend fun bearer(): String {
        access?.let { (value, until) -> if (System.currentTimeMillis() < until) return value }
        val credential = mutex.withLock { login } ?: throw HubAccountException(HubAccountException.Kind.AUTHENTICATION_REQUIRED)
        val expected = mutex.withLock { generation }
        val response = try {
            send("/api/auth/token", credential = credential)
        } catch (error: HubAccountException) {
            if (error.kind == HubAccountException.Kind.AUTHENTICATION_REQUIRED && mutex.withLock { generation } == expected) clear()
            throw error
        }
        val token = response.json()["token"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        if (mutex.withLock { generation } != expected || mutex.withLock { login } != credential) {
            throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        }
        if (!validCredential(token) || token.count { it == '.' } != 2) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        mutex.withLock {
            access = token to (System.currentTimeMillis() + 600_000)
            if (credential.count { it == '.' } == 2) {
                login = token
                credentialStorage.save(token)
            }
        }
        return token
    }

    suspend fun hosts(): List<HubDirectoryHost> {
        val expected = mutex.withLock { generation }
        val token = bearer()
        val response = send("/api/hub/hosts", credential = token)
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        val data = response.json()["data"]?.array ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        val hosts = data.map { HubDirectoryHost.fromJson(it) }
        if (hosts.size > 64 || hosts.map { it.id }.toSet().size != hosts.size) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        for (host in hosts) {
            if (!Regex("^[A-Za-z0-9_-]{16,128}$").matches(host.hostID)) throw HubAccountException(HubAccountException.Kind.MALFORMED)
            if (host.name.isEmpty() || host.name.length > 512) throw HubAccountException(HubAccountException.Kind.MALFORMED)
            val key = BinaryEncoding.decodeOrNull(host.publicKey, 65) ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
            runCatching { Crypto.pointOf(key) }.getOrElse { throw HubAccountException(HubAccountException.Kind.MALFORMED) }
            host.runtimeID?.let {
                runCatching { RemoteTarget(host.hostID, it).validate() }
                    .getOrElse { throw HubAccountException(HubAccountException.Kind.MALFORMED) }
            }
        }
        return hosts
    }

    /** Account identity comes from authenticated metadata, not JWT claims or a device request. */
    suspend fun authenticatedAccountID(): String {
        val expected = mutex.withLock { generation }
        verifiedAccount?.let { (current, id) -> if (current == expected) return id }
        bearer()
        val credential = mutex.withLock { login } ?: throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        val response = send("/api/auth/get-session", credential = credential)
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        val id = response.json()["user"]?.get("id")?.string?.takeIf { Regex("^[A-Za-z0-9_-]{16,128}$").matches(it) }
            ?: throw HubAccountException(HubAccountException.Kind.AUTHENTICATION_REQUIRED)
        mutex.withLock { verifiedAccount = expected to id }
        return id
    }

    suspend fun enrollmentContext(): Pair<Long, String> {
        val expected = mutex.withLock { generation }
        val id = authenticatedAccountID()
        requireGeneration(expected)
        return expected to id
    }

    suspend fun requireGeneration(expected: Long) {
        val current = mutex.withLock { generation to login }
        if (current.first != expected || current.second == null) {
            throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        }
    }

    suspend fun roster(): SignedAccountRoster? {
        val expected = mutex.withLock { generation }
        val accountID = authenticatedAccountID()
        val token = bearer()
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        val response = send("/api/hub/roster", credential = token)
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        return SignedAccountRoster.hubRecord(response.body, accountID)
    }

    suspend fun publishRoster(roster: SignedAccountRoster): SignedAccountRoster {
        val expected = mutex.withLock { generation }
        val accountID = authenticatedAccountID()
        if (roster.roster.accountID != accountID) throw AccountRosterException(AccountRosterException.Reason.ACCOUNT_MISMATCH)
        val digest = roster.fingerprint()
        val token = bearer()
        val body = CanonicalJson.encodeBytes(
            JsonValue.obj(
                "sequence" to JsonValue.of(roster.roster.sequence),
                "payload" to roster.roster.toJson(),
                "signature" to JsonValue.of(roster.signature),
                "digest" to JsonValue.of(digest),
            ),
        )
        val response = send("/api/hub/roster", credential = token, body = body, method = "PUT")
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        val published = SignedAccountRoster.hubRecord(response.body, accountID)
            ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        if (published.fingerprint() != digest) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        return published
    }

    suspend fun pushRegistrationAvailable(requireDelivery: Boolean = false): Boolean {
        val expected = mutex.withLock { generation }
        val token = bearer()
        val response = send("/api/hub/version", credential = token)
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        val value = response.json()
        val protocol = value["protocol"]?.long ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        val capabilities = (value["capabilities"]?.array ?: throw HubAccountException(HubAccountException.Kind.MALFORMED))
            .map { it.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED) }
        if (protocol != 1L || capabilities.size > 32 || capabilities.any { it.length > 128 }) {
            throw HubAccountException(HubAccountException.Kind.MALFORMED)
        }
        return capabilities.contains("push-registration") && (!requireDelivery || capabilities.contains("push-delivery"))
    }

    suspend fun registerPush(deviceID: String, token: String, environment: String): Pair<Long, String> {
        if (environment != "sandbox" && environment != "production") throw HubAccountException(HubAccountException.Kind.MALFORMED)
        val expected = mutex.withLock { generation }
        val bearer = bearer()
        val body = CanonicalJson.encodeBytes(
            JsonValue.obj(
                "deviceID" to JsonValue.of(deviceID),
                "token" to JsonValue.of(token),
                "environment" to JsonValue.of(environment),
            ),
        )
        val response = send("/api/hub/push/register", credential = bearer, body = body)
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        val value = response.json()
        val registeredAt = value["registeredAt"]?.long ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        val registrationID = value["registrationID"]?.string ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        if (registeredAt < 0 || runCatching { java.util.UUID.fromString(registrationID) }.isFailure) {
            throw HubAccountException(HubAccountException.Kind.MALFORMED)
        }
        return registeredAt to registrationID
    }

    suspend fun pushContext(deviceID: String, signalID: String): HubPushNotice {
        if (!Regex("^[A-Za-z0-9_-]{87}$").matches(deviceID) || !Regex("^[A-Za-z0-9_-]{16,128}$").matches(signalID)) {
            throw HubAccountException(HubAccountException.Kind.MALFORMED)
        }
        val expected = mutex.withLock { generation }
        val token = bearer()
        val response = send(
            "/api/hub/push/context",
            credential = token,
            query = listOf("deviceID" to deviceID, "signalID" to signalID),
        )
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        if (response.body.size > 8192) throw HubAccountException(HubAccountException.Kind.MALFORMED)
        val notice = HubPushNotice.fromJson(response.json())
        if (notice.binding.deviceID != deviceID || notice.binding.signalID != signalID) {
            throw HubAccountException(HubAccountException.Kind.MALFORMED)
        }
        return notice
    }

    suspend fun revokePush(deviceID: String) {
        val key = BinaryEncoding.decodeOrNull(deviceID, 65) ?: throw HubAccountException(HubAccountException.Kind.MALFORMED)
        runCatching { Crypto.pointOf(key) }.getOrElse { throw HubAccountException(HubAccountException.Kind.MALFORMED) }
        val expected = mutex.withLock { generation }
        val token = bearer()
        val body = CanonicalJson.encodeBytes(JsonValue.obj("deviceID" to JsonValue.of(deviceID)))
        val response = send("/api/hub/push/revoke", credential = token, body = body)
        if (mutex.withLock { generation } != expected) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        if (response.json()["revoked"]?.bool != true) throw HubAccountException(HubAccountException.Kind.MALFORMED)
    }

    suspend fun signOut() {
        val credential = mutex.withLock { login ?: pendingLogout }
        clear()
        mutex.withLock { pendingLogout = credential }
        if (credential == null) return
        try {
            send("/api/auth/sign-out", credential = credential, body = "{}".toByteArray())
        } catch (_: HubAccountException) {
        }
        mutex.withLock { if (pendingLogout == credential) pendingLogout = null }
    }

    suspend fun close() {
        mutex.withLock {
            generation += 1
            login = null
            pendingLogout = null
            access = null
        }
    }

    /** Directory discovery can replace an execution instance, never the pinned identity or grant. */
    suspend fun refreshedHost(host: ApprovedHost): ApprovedHost {
        requireOrigin(host.hubURL)
        val current = hosts().firstOrNull {
            it.hostID == host.target.hostID && it.runtimeID == host.target.runtimeID
        } ?: throw AuthorizationBlockedException()
        if (current.revokedAt != null || current.publicKey != host.publicKey) throw AuthorizationBlockedException()
        val runtimeID = current.runtimeID ?: throw RemoteRPCException.Disconnected()
        if (!current.online) throw RemoteRPCException.Disconnected()
        return host.copy(target = RemoteTarget(host.target.hostID, runtimeID))
    }

    suspend fun relayAuthorization(hubURL: String, hostID: String, runtimeID: String?): String {
        requireOrigin(hubURL)
        runCatching { RemoteTarget(hostID, runtimeID ?: hostID).validate() }.getOrElse { throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT) }
        val expected = mutex.withLock { generation }
        val token = bearer()
        if (mutex.withLock { generation } != expected || mutex.withLock { login } == null) {
            throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
        }
        return token
    }

    private fun requireOrigin(hubURL: String) {
        val supplied = try {
            URI(hubURL)
        } catch (_: Exception) {
            throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT)
        }
        val canonical = URI(origin)
        if (
            supplied.userInfo != null || supplied.rawQuery != null || supplied.rawFragment != null ||
            !(supplied.rawPath.isNullOrEmpty() || supplied.rawPath == "/") ||
            supplied.scheme?.lowercase() != canonical.scheme?.lowercase() ||
            supplied.host?.lowercase() != canonical.host?.lowercase() ||
            effectivePort(supplied) != effectivePort(canonical)
        ) {
            throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT)
        }
    }

    private fun effectivePort(uri: URI): Int =
        if (uri.port != -1) uri.port else if (uri.scheme?.lowercase() == "https") 443 else 80

    private class HttpResponse(val status: Int, val body: ByteArray, val headers: Map<String, String>) {
        fun json(): JsonValue = try {
            CanonicalJson.parse(body)
        } catch (_: JsonParseException) {
            throw HubAccountException(HubAccountException.Kind.MALFORMED)
        }
    }

    private suspend fun send(
        path: String,
        credential: String? = null,
        body: ByteArray? = null,
        query: List<Pair<String, String>> = emptyList(),
        method: String? = null,
    ): HttpResponse {
        val url = buildString {
            append(origin)
            append(path)
            if (query.isNotEmpty()) {
                append('?')
                query.forEachIndexed { index, (key, value) ->
                    if (index > 0) append('&')
                    append(URLEncoder.encode(key, "UTF-8"))
                    append('=')
                    append(URLEncoder.encode(value, "UTF-8"))
                }
            }
        }
        val request = Request.Builder().url(url).apply {
            method(method ?: if (body == null) "GET" else "POST", body?.toRequestBody("application/json".toMediaType()))
            header("Origin", origin)
            header("Accept", "application/json")
            credential?.let { header("Authorization", "Bearer $it") }
        }.build()
        val response = withContext(Dispatchers.IO) { client.newCall(request).execute() }
        response.use { value ->
            val bytes = value.body?.bytes() ?: ByteArray(0)
            if (bytes.size > 128 * 1024) throw HubAccountException(HubAccountException.Kind.MALFORMED)
            val headers = buildMap {
                for (name in listOf("set-auth-token")) value.header(name)?.let { put(name, it) }
            }
            if (value.code !in 200..299) {
                if (value.code == 401 || value.code == 403) {
                    throw HubAccountException(HubAccountException.Kind.AUTHENTICATION_REQUIRED, value.code)
                }
                throw HubAccountException(HubAccountException.Kind.REJECTED, value.code)
            }
            return HttpResponse(value.code, bytes, headers)
        }
    }

    private suspend fun clear() {
        mutex.withLock {
            generation += 1
            login = null
            access = null
        }
        credentialStorage.remove()
    }

    companion object {
        private val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .writeTimeout(20, TimeUnit.SECONDS)
                .build()
        }

        private fun normalizeOrigin(origin: String, allowLoopbackHTTP: Boolean): String {
            val uri = try {
                URI(origin)
            } catch (_: Exception) {
                throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT)
            }
            val scheme = uri.scheme?.lowercase() ?: throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT)
            val host = uri.host?.lowercase() ?: throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT)
            val local = allowLoopbackHTTP && scheme == "http" && host in setOf("localhost", "127.0.0.1", "::1", "[::1]")
            if (scheme != "https" && !local) throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT)
            if (
                uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
                !(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") ||
                host.isEmpty() || uri.port !in -1..65535 || uri.port == 0
            ) {
                throw HubAccountException(HubAccountException.Kind.INVALID_ENDPOINT)
            }
            val port = when {
                uri.port == -1 -> ""
                scheme == "https" && uri.port == 443 -> ""
                scheme == "http" && uri.port == 80 -> ""
                else -> ":" + uri.port
            }
            return "$scheme://$host$port"
        }

        private fun validCredential(value: String): Boolean =
            value.isNotEmpty() && value.length <= 8192 && value.all { it.code in 33..126 }
    }
}
