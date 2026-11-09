package dev.miao.app

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.miao.core.AccountEnrollment
import dev.miao.core.AccountEnrollmentApproval
import dev.miao.core.AccountEnrollmentRequest
import dev.miao.core.AccountEnrollmentStore
import dev.miao.core.AccountRosterException
import dev.miao.core.AcceptedAccountEnrollment
import dev.miao.core.CanonicalJson
import dev.miao.core.ClientScenePhase
import dev.miao.core.DeviceIdentity
import dev.miao.core.HostRegistry
import dev.miao.core.HubAccount
import dev.miao.core.HubAccountException
import dev.miao.core.HubConnection
import dev.miao.core.HubDirectoryHost
import dev.miao.core.PairingInvitation
import dev.miao.core.RemoteConnectionState
import dev.miao.core.RemoteRPCException
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Same shape as the iOS AppModel: one signed-in Hub identity, many authorized computers. */
class AppModel(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val preferences = context.getSharedPreferences("miao", Context.MODE_PRIVATE)
    private val identity = DeviceIdentity(KeystoreIdentityStorage(context))
    private val directory = File(context.filesDir, "remote")
    private val sceneID = UUID.randomUUID()

    var hosts by mutableStateOf<List<dev.miao.core.AuthorizedHost>>(emptyList())
        private set
    var attempts by mutableStateOf<List<dev.miao.core.PairingAttempt>>(emptyList())
        private set
    var error by mutableStateOf<String?>(null)
    var incomingPairLink by mutableStateOf<String?>(null)
    var pairing by mutableStateOf<String?>(null)
        private set
    var fingerprint by mutableStateOf<String?>(null)
        private set
    var accountURL by mutableStateOf("")
    var accountSignedIn by mutableStateOf(false)
        private set
    var accountBusy by mutableStateOf(false)
        private set
    var accountError by mutableStateOf<String?>(null)
    var discoveredHosts by mutableStateOf<List<HubDirectoryHost>>(emptyList())
    var enrollmentRequest by mutableStateOf("")
    var enrollmentIncoming by mutableStateOf("")
    var enrollmentResponse by mutableStateOf("")
    var enrollmentApproved by mutableStateOf("")
    var enrollmentPin by mutableStateOf("")
    var enrollmentSigner by mutableStateOf("")
    var enrollmentSignerConsent by mutableStateOf(false)
    var enrollmentIndependentPin by mutableStateOf(false)
    var enrollmentBusy by mutableStateOf(false)
        private set
    var enrollmentError by mutableStateOf<String?>(null)
    var enrollmentComplete by mutableStateOf(false)

    val clients = mutableStateMapOf<UUID, HostClient>()
    private var registry: HostRegistry? = null
    private var enrollmentStore: AccountEnrollmentStore? = null
    private var enrollment: AccountEnrollment? = null
    private var account: HubAccount? = null
    private var accountLoaded = false
    private var accountIdentityID: String? = null
    private var accountEpoch = 0
    private var pairTask: Job? = null
    private var loadTask: Job? = null
    private var directoryRefreshing = false
    private var phase = ClientScenePhase.ACTIVE

    val defaultAccountURL: String
        get() = BuildConfig.HUB_ORIGIN.ifEmpty { "https://hub.mtty.dev" }

    fun hostClient(id: UUID): HostClient? = clients[id]

    fun load() {
        if (loadTask != null) return
        loadTask = scope.launch {
            try {
                initialize()
            } catch (failure: Throwable) {
                error = userMessage(failure)
            } finally {
                loadTask = null
            }
        }
    }

    private suspend fun initialize() {
        val key = identity.loadOrCreate()
        if (registry == null) registry = HostRegistry(directory, key.publicKeyEncoded)
        if (enrollmentStore == null) enrollmentStore = AccountEnrollmentStore(directory, key.publicKeyEncoded)
        if (!accountLoaded) {
            accountLoaded = true
            restoreAccount()
        }
        reload()
        if (accountSignedIn) refreshDirectory()
    }

    private suspend fun reload() {
        val registry = registry ?: return
        val snapshot = registry.snapshot()
        val signedInAccount = if (accountSignedIn) accountIdentityID else null
        val visible = snapshot.first.filter { it.accountID == signedInAccount && it.accountID != null } +
            snapshot.first.filter { it.accountID == null }
        for ((id, client) in clients) {
            if (visible.none {
                    it == client.record ||
                        (it.accountID != null && it.accountID == client.record.accountID && it.host == client.record.host)
                }
            ) {
                client.close()
                clients.remove(id)
            }
        }
        hosts = visible
        attempts = snapshot.second
        for (record in visible) {
            if (clients[record.id] != null) continue
            val client = HostClient(record, identity, File(directory, "checkpoints"), accountFor(record.host.hubURL), scope)
            clients[record.id] = client
            if (record.accountID != null) client.scene(sceneID, phase)
        }
    }

    fun pair(uri: String, label: String) {
        if (pairTask != null) return
        val registry = registry ?: return
        val invitation = try {
            PairingInvitation.parse(uri)
        } catch (failure: Throwable) {
            error = userMessage(failure)
            return
        }
        if (!accountSignedIn) {
            error = "请先登录电脑使用的中继，再扫码配对"
            return
        }
        error = null
        fingerprint = null
        pairing = "正在连接电脑…"
        pairTask = scope.launch {
            try {
                registry.begin(invitation)
                val paired = HubConnection.pair(
                    invitation = invitation,
                    identity = identity.loadOrCreate(),
                    label = label,
                    authorize = { account?.relayAuthorization(invitation.hubURL, invitation.hostID, invitation.runtimeID) },
                    pending = { value ->
                        fingerprint = value
                        pairing = "请在电脑上核对指纹并批准"
                    },
                    persist = { host, grant -> registry.approve(host, grant, invitation.pairingID) },
                    reconcile = { throw RemoteRPCException.Disconnected() },
                )
                paired.connection.close()
                reload()
                pairing = null
                fingerprint = null
            } catch (failure: Throwable) {
                error = userMessage(failure)
                pairing = null
                runCatching { reload() }
            } finally {
                pairTask = null
            }
        }
    }

    fun cancelPairing() {
        pairTask?.cancel()
        pairTask = null
        pairing = null
        fingerprint = null
    }

    private fun accountFor(hubURL: String): HubAccount? {
        val current = account ?: return null
        if (!accountSignedIn) return null
        val left = java.net.URI(hubURL)
        val right = java.net.URI(current.origin)
        val samePort = (left.port.takeIf { it != -1 } ?: if (left.scheme == "https") 443 else 80) ==
            (right.port.takeIf { it != -1 } ?: if (right.scheme == "https") 443 else 80)
        return if (
            left.scheme?.lowercase() == right.scheme?.lowercase() &&
            left.host?.lowercase() == right.host?.lowercase() && samePort
        ) {
            current
        } else {
            null
        }
    }

    private suspend fun restoreAccount() {
        val saved = preferences.getString("hub-origin", null) ?: return
        accountURL = saved
        runCatching {
            val restored = HubAccount(saved, KeystoreCredentialStorage(context, saved))
            account = restored
            accountSignedIn = restored.restore()
            if (accountSignedIn) refreshDirectory()
        }.onFailure { accountError = "中继登录未恢复，请重新登录" }
    }

    fun signIn(origin: String, email: String, password: String) {
        if (accountBusy) return
        accountBusy = true
        accountError = null
        accountEpoch += 1
        val generation = accountEpoch
        scope.launch {
            try {
                val trimmed = origin.trim()
                val resolved = if (trimmed.isEmpty()) defaultAccountURL else trimmed
                val next = HubAccount(resolved, KeystoreCredentialStorage(context, resolved))
                accountIdentityID = null
                accountSignedIn = false
                discoveredHosts = emptyList()
                clearEnrollment()
                pairTask?.cancel()
                clients.values.forEach { it.close() }
                clients.clear()
                account?.signOut()
                account?.close()
                if (next.restore()) next.signOut()
                next.signIn(email.trim(), password)
                if (generation != accountEpoch) {
                    next.signOut()
                    next.close()
                    return@launch
                }
                account = next
                accountURL = next.origin
                accountSignedIn = true
                preferences.edit().putString("hub-origin", next.origin).apply()
                reload()
                refreshDirectory()
            } catch (failure: Throwable) {
                if (generation == accountEpoch) {
                    accountError = accountMessage(failure)
                    runCatching { reload() }
                }
            } finally {
                if (generation == accountEpoch) accountBusy = false
            }
        }
    }

    fun signOut() {
        if (accountBusy) return
        accountBusy = true
        accountEpoch += 1
        accountIdentityID = null
        accountSignedIn = false
        discoveredHosts = emptyList()
        scope.launch {
            try {
                clearEnrollment()
                pairTask?.cancel()
                clients.values.forEach { it.close() }
                clients.clear()
                try {
                    account?.signOut()
                    accountError = null
                } catch (_: Throwable) {
                    accountError = "已从本机退出。中继撤销未确认，请联网后再次退出登录"
                }
                runCatching { reload() }
            } finally {
                accountBusy = false
            }
        }
    }

    fun refreshDirectory() {
        if (directoryRefreshing) return
        val current = account
        if (!accountSignedIn || current == null) return
        directoryRefreshing = true
        accountError = null
        val generation = accountEpoch
        scope.launch {
            try {
                val directoryHosts = current.hosts()
                if (generation != accountEpoch || !accountSignedIn) return@launch
                registry?.let { registry ->
                    runCatching { registry.rename(directoryHosts, current.origin) }
                    reload()
                }
                admitSignedInHosts(directoryHosts, current, generation)
                if (generation != accountEpoch || !accountSignedIn) return@launch
                discoveredHosts = directoryHosts
            } catch (failure: Throwable) {
                if (generation != accountEpoch) return@launch
                accountError = accountMessage(failure)
                if (failure is HubAccountException && failure.kind == HubAccountException.Kind.AUTHENTICATION_REQUIRED) {
                    accountIdentityID = null
                    accountSignedIn = false
                    discoveredHosts = emptyList()
                    clients.values.forEach { it.close() }
                    clients.clear()
                }
            } finally {
                directoryRefreshing = false
            }
        }
    }

    /** One tap connects account computers: enrolled devices use accepted trust, fresh devices auto-admit. */
    fun connectAccountDevices() {
        if (accountBusy || enrollmentBusy || !accountSignedIn) return
        val current = account ?: return
        accountBusy = true
        accountError = null
        val generation = accountEpoch
        scope.launch {
            try {
                val directoryHosts = current.hosts()
                if (generation != accountEpoch || !accountSignedIn) return@launch
                val accountID = current.authenticatedAccountID()
                registry?.restoreAccountHosts(current.origin, accountID)
                admitSignedInHosts(directoryHosts, current, generation)
                if (generation != accountEpoch || !accountSignedIn) return@launch
                refreshDirectory()
            } catch (failure: Throwable) {
                if (generation == accountEpoch) accountError = accountMessage(failure)
            } finally {
                accountBusy = false
            }
        }
    }

    private suspend fun admitSignedInHosts(
        directory: List<HubDirectoryHost>,
        account: HubAccount,
        epoch: Int,
    ) {
        val registry = registry ?: return
        val accountID = account.authenticatedAccountID()
        accountIdentityID = accountID
        val origin = account.origin
        val key = identity.loadOrCreate()
        registry.synchronizeAccount(origin, accountID, directory)
        for (host in directory) {
            if (!host.online || host.revokedAt != null) continue
            if (registry.isAccountHostHidden(origin, accountID, host.hostID)) continue
            if (epoch != accountEpoch || !accountSignedIn) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
            val existing = hosts.firstOrNull {
                it.host.hubURL == origin && it.host.target.hostID == host.hostID &&
                    it.host.target.runtimeID == host.runtimeID
            }
            if (existing != null && existing.accountID == accountID && !existing.expired) continue
            runCatching {
                val admitted = HubConnection.autoAdmit(
                    account = account,
                    discovered = host,
                    identity = key,
                    accountAccess = true,
                    existingID = existing?.id,
                    persist = { record, grant -> registry.admitSignedIn(record, grant, accountID) },
                    reconcile = { throw RemoteRPCException.Disconnected() },
                )
                admitted.connection.close()
            }.onFailure {
                if (epoch != accountEpoch || !accountSignedIn) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
                accountError = accountMessage(it)
            }
        }
        reload()
    }

    private fun clearEnrollment() {
        scope.launch {
            enrollment?.cancel()
            enrollment = null
        }
        enrollmentRequest = ""
        enrollmentIncoming = ""
        enrollmentResponse = ""
        enrollmentApproved = ""
        enrollmentPin = ""
        enrollmentSigner = ""
        enrollmentSignerConsent = false
        enrollmentIndependentPin = false
        enrollmentError = null
        enrollmentComplete = false
    }

    fun initializeAccountSigner() {
        if (!enrollmentSignerConsent || accountBusy || enrollmentBusy || !accountSignedIn) return
        val current = account ?: return
        val store = enrollmentStore ?: return
        enrollmentBusy = true
        enrollmentError = null
        enrollmentComplete = false
        val epoch = accountEpoch
        scope.launch {
            try {
                val key = identity.loadOrCreate()
                val id = current.authenticatedAccountID()
                val existing = current.roster()
                if (epoch != accountEpoch || !accountSignedIn) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
                val rooted = AcceptedAccountEnrollment.root(key, current.origin, id, hosts, existing)
                if (existing == null) current.publishRoster(rooted.roster)
                if (epoch != accountEpoch || !accountSignedIn) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
                store.accept(rooted)
                if (epoch != accountEpoch) return@launch
                enrollmentSigner = key.publicKeyEncoded
            } catch (failure: Throwable) {
                if (epoch == accountEpoch) {
                    enrollmentError = "初始化未完成。请先独立配对电脑，并在电脑明确选择此设备作为账号签名设备。"
                }
            } finally {
                enrollmentBusy = false
            }
        }
    }

    fun createEnrollmentRequest() {
        if (accountBusy || enrollmentBusy || !accountSignedIn) return
        val current = account ?: return
        enrollmentBusy = true
        enrollmentError = null
        enrollmentComplete = false
        val epoch = accountEpoch
        scope.launch {
            try {
                val key = identity.loadOrCreate()
                val id = current.authenticatedAccountID()
                if (epoch != accountEpoch || !accountSignedIn) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
                val flow = enrollment ?: AccountEnrollment(key).also { enrollment = it }
                val request = flow.begin(current.origin, id, "Android 设备")
                if (epoch != accountEpoch) return@launch
                enrollmentRequest = String(request, Charsets.UTF_8)
            } catch (failure: Throwable) {
                if (epoch == accountEpoch) enrollmentError = "无法生成注册码，请检查账号连接后重试。"
            } finally {
                enrollmentBusy = false
            }
        }
    }

    fun approveEnrollmentRequest() {
        if (accountBusy || enrollmentBusy || !accountSignedIn) return
        val current = account ?: return
        val store = enrollmentStore ?: return
        enrollmentBusy = true
        enrollmentError = null
        enrollmentResponse = ""
        val epoch = accountEpoch
        scope.launch {
            try {
                if (enrollmentIncoming.length > 8192) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
                val request = AccountEnrollmentRequest.decode(enrollmentIncoming.toByteArray())
                val id = current.authenticatedAccountID()
                val roster = current.roster() ?: throw AccountRosterException(AccountRosterException.Reason.UNTRUSTED_SIGNER)
                val trusted = store.refresh(roster, current.origin, id)
                if (epoch != accountEpoch || !accountSignedIn) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
                val key = identity.loadOrCreate()
                val approved = AccountEnrollmentApproval.approve(
                    identity = key,
                    request = request,
                    hubURL = current.origin,
                    current = trusted.roster,
                    authority = trusted.authority,
                    pairedHosts = trusted.hosts,
                )
                val published = current.publishRoster(approved.roster)
                if (epoch != accountEpoch || !accountSignedIn) throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
                store.refresh(published, current.origin, id)
                if (epoch != accountEpoch) return@launch
                enrollmentResponse = String(CanonicalJson.encodeBytes(approved.toJson()), Charsets.UTF_8)
                enrollmentSigner = key.publicKeyEncoded
            } catch (failure: Throwable) {
                if (epoch == accountEpoch) enrollmentError = "批准未完成。请核对注册码、签名设备资格与账号后重试。"
            } finally {
                enrollmentBusy = false
            }
        }
    }

    fun receiveEnrollmentApproval() {
        val missing = buildList {
            if (!enrollmentIndependentPin) add("独立来源确认")
            if (!accountSignedIn) add("账号登录")
            if (enrollment == null) add("注册会话")
            if (enrollmentStore == null) add("本地信任存储")
            if (accountBusy || enrollmentBusy) add("其他操作进行中")
        }
        if (missing.isNotEmpty()) {
            enrollmentError = "暂不能完成注册：缺" + missing.joinToString("、")
            return
        }
        val current = account ?: return
        val store = enrollmentStore ?: return
        val flow = enrollment ?: return
        enrollmentBusy = true
        enrollmentError = null
        enrollmentComplete = false
        val epoch = accountEpoch
        scope.launch {
            try {
                if (enrollmentApproved.length > 131072) throw AccountRosterException(AccountRosterException.Reason.MALFORMED)
                val id = current.authenticatedAccountID()
                val accepted = flow.receive(enrollmentApproved.toByteArray(), enrollmentPin.trim())
                if (
                    epoch != accountEpoch || !accountSignedIn || accepted.authority.accountID != id ||
                    accepted.hubURL != current.origin
                ) {
                    throw HubAccountException(HubAccountException.Kind.SUPERSEDED)
                }
                store.accept(accepted)
                if (epoch != accountEpoch || !accountSignedIn) return@launch
                enrollmentRequest = ""
                enrollmentApproved = ""
                refreshDirectory()
                if (epoch != accountEpoch) return@launch
                accountError?.let { enrollmentError = it } ?: run { enrollmentComplete = true }
            } catch (failure: Throwable) {
                if (epoch == accountEpoch) enrollmentError = "注册未完成。请使用已信任设备直接提供的批准结果和签名公钥。"
            } finally {
                enrollmentBusy = false
            }
        }
    }

    fun scenePhase(phase: ClientScenePhase) {
        this.phase = phase
        for (client in clients.values) {
            if (client.record.accountID != null) scope.launch { client.scene(sceneID, phase) }
        }
    }

    fun forget(id: UUID) {
        scope.launch {
            try {
                val client = clients[id]
                val accountID = if (account != null && client != null && account?.origin == client.record.host.hubURL) {
                    runCatching { account?.authenticatedAccountID() }.getOrNull()
                } else {
                    null
                }
                registry?.forget(id, accountID)
                client?.close()
                client?.store?.clear()
                clients.remove(id)
                reload()
            } catch (failure: Throwable) {
                error = userMessage(failure)
            }
        }
    }

    fun pairingBusy(): Boolean = pairing != null

    fun remoteStateFor(id: UUID): RemoteConnectionState =
        clients[id]?.state ?: RemoteConnectionState.QUIESCENT

    private fun accountMessage(error: Throwable): String = when (error) {
        is HubAccountException -> when (error.kind) {
            HubAccountException.Kind.INVALID_ENDPOINT -> "请输入电脑配置的 HTTPS 中继地址"
            HubAccountException.Kind.AUTHENTICATION_REQUIRED -> "登录已失效，请重新登录中继"
            HubAccountException.Kind.INVALID_CREDENTIALS -> "登录未成功，请核对邮箱、密码和中继地址"
            HubAccountException.Kind.REJECTED -> if (error.status == 404) {
                "这个中继不支持此功能，请更新 App 或核对中继地址"
            } else {
                "登录未成功，请核对邮箱、密码和中继地址"
            }
            HubAccountException.Kind.STORAGE -> "设备凭证暂时不可用，请解锁后重试"
            else -> "暂时无法连接中继，请检查网络后重试"
        }
        is dev.miao.core.AuthorizationBlockedException ->
            "账号远控接入被拒绝，请确认电脑与中继支持账号接入，且两端登录的是同一账号"
        is dev.miao.core.ProtocolIncompatibleException -> "请更新电脑和 App 后重试账号远控"
        else -> "暂时无法连接中继，请检查网络后重试"
    }
}
