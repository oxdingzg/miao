import Foundation
import SwiftUI
import Observation
import CryptoKit
import MiaoCore
import UIKit
import AuthenticationServices
import UserNotifications

@MainActor @Observable
final class AppModel {
    let identity = DeviceIdentity(service: AppTestConfiguration.runID.map { "miao.remote.ui-test." + $0 } ?? "miao.remote.device")
    let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent(AppTestConfiguration.runID.map { "MiaoRemoteUITest-" + $0 } ?? "MiaoRemote")
    var hosts: [AuthorizedHost] = []
    var attempts: [PairingAttempt] = []
    var clients: [UUID: HostClient] = [:]
    var error: String?
    var pairing: String?
    var fingerprint: String?
    var accountURL = ""
    /// Build-time default relay origin (`MIAO_HUB_ORIGIN`), so a preconfigured
    /// build lands on its own Hub without asking the user to type it.
    var defaultAccountURL: String { (Bundle.main.object(forInfoDictionaryKey: "MiaoHubOrigin") as? String) ?? "" }
    var accountSignedIn = false
    var accountBusy = false
    var revocationPending = false
    var accountError: String?
    var discoveredHosts: [HubDirectoryHost] = []
    var connectionEpoch = 0
    var notificationsBusy = false
    var notificationsRegistered = false
    var notificationsError: String?
    var notificationsWanted = false
    var notificationsRevocationPending = false
    var notificationHostID: UUID?
    var notificationDestination: NotificationDestination?
    private var notificationOpenTask: Task<Void, Never>?
    private var notificationEpoch = 0
    private var pushTask: Task<Void, Never>?
    private var account: HubAccount?
    private var accountOrigin: URL?
    private var accountLoaded = false
    private var accountEpoch = 0
    private var loadTask: Task<Void, Never>?
    private var registry: HostRegistry?
    private var pairTask: Task<Void, Never>?
    private var scenes: [UUID: ScenePhase] = [:]
    private var reloadEpoch = 0

    private var notificationPreference: String {
        AppTestConfiguration.runID.map { "miao.remote.ui-test-notifications." + $0 } ?? "miao.remote.notifications"
    }

    func openNotification(_ signalID: String) {
        notificationOpenTask?.cancel()
        notificationDestination = nil
        notificationOpenTask = Task {
            await load()
            guard !Task.isCancelled, accountSignedIn, let account else { return }
            let epoch = accountEpoch
            do {
                let key = try await identity.loadOrCreate()
                let notice = try await account.pushContext(deviceID: publicKey(key), signalID: signalID)
                let origin = await account.origin
                guard !Task.isCancelled, accountEpoch == epoch, accountSignedIn,
                      let record = hosts.first(where: { $0.host.target.hostID == notice.binding.hostID && $0.host.hubURL == origin }),
                      let client = clients[record.id] else { throw HubAccountError.authenticationRequired }
                let payload = try notice.resolve(device: key, host: record)
                notificationHostID = record.id
                let until = Date().addingTimeInterval(15)
                while !client.ready && Date() < until {
                    try Task.checkCancellation()
                    guard accountEpoch == epoch, accountSignedIn, hosts.contains(where: { $0.id == record.id }) else {
                        throw HubAccountError.superseded
                    }
                    try await Task.sleep(for: .milliseconds(100))
                }
                guard client.ready, client.runtimeID == notice.binding.runtimeID else { throw HubAccountError.superseded }
                let result = try await client.request(.sessionGet, sessionID: payload.sessionID)
                guard !Task.isCancelled, accountEpoch == epoch, accountSignedIn,
                      let summary = SessionSummary(result), summary.id == payload.sessionID,
                      summary.projectID == payload.projectID, payload.expiresAt > Int64(Date().timeIntervalSince1970 * 1000),
                      hosts.contains(where: { $0.id == record.id }) else { throw HubAccountError.superseded }
                notificationDestination = NotificationDestination(hostID: record.id, summary: summary)
            } catch {
                if !Task.isCancelled && accountEpoch == epoch { notificationsError = "无法打开此通知，请从电脑列表查看当前会话" }
            }
        }
    }

    func enableNotifications() async {
        guard !notificationsBusy, !notificationsRevocationPending, accountSignedIn, let account else { return }
        notificationsBusy = true; notificationsError = nil
        let epoch = accountEpoch
        defer { notificationsBusy = false }
        do {
            guard let raw = Bundle.main.object(forInfoDictionaryKey: "MiaoPushEnvironment") as? String,
                  PushEnvironment(rawValue: raw) != nil,
                  try await account.pushRegistrationAvailable(requireDelivery: true) else {
                notificationsError = "此连接暂不支持通知"; return
            }
            guard epoch == accountEpoch, accountSignedIn else { return }
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            guard epoch == accountEpoch, accountSignedIn else { return }
            guard allowed else { notificationsError = "请在系统设置中允许 miao 通知"; return }
            notificationsWanted = true
            UserDefaults.standard.set(true, forKey: notificationPreference)
            UIApplication.shared.registerForRemoteNotifications()
        } catch { if epoch == accountEpoch { notificationsError = "通知连接未完成，请重试" } }
    }

    func disableNotifications() async {
        guard !notificationsBusy else { return }
        notificationsBusy = true
        notificationsWanted = false; notificationsRegistered = false; notificationEpoch += 1
        UserDefaults.standard.set(false, forKey: notificationPreference)
        UIApplication.shared.unregisterForRemoteNotifications()
        AppNotifications.shared.forget()
        let epoch = accountEpoch
        await pushTask?.value
        defer { notificationsBusy = false }
        guard epoch == accountEpoch else { return }
        do {
            if accountSignedIn, let account {
                let key = try await identity.loadOrCreate()
                try await account.revokePush(deviceID: publicKey(key))
            }
            guard epoch == accountEpoch else { return }
            notificationsRevocationPending = false; notificationsError = nil
            UserDefaults.standard.set(false, forKey: notificationPreference + ".revoke")
        } catch {
            guard epoch == accountEpoch else { return }
            notificationsRevocationPending = true
            UserDefaults.standard.set(true, forKey: notificationPreference + ".revoke")
            notificationsError = "通知已在本机关闭，中继注销未确认，请重试"
        }
    }

    func receivePushToken(_ token: Data) {
        guard notificationsWanted, accountSignedIn, let account,
              let raw = Bundle.main.object(forInfoDictionaryKey: "MiaoPushEnvironment") as? String,
              let environment = PushEnvironment(rawValue: raw) else { return }
        notificationEpoch += 1
        let generation = notificationEpoch
        let epoch = accountEpoch
        let previous = pushTask
        pushTask = Task {
            await previous?.value
            guard generation == notificationEpoch, epoch == accountEpoch, notificationsWanted, accountSignedIn else { return }
            do {
                let key = try await identity.loadOrCreate()
                let registration = try PushDeviceRegistration(deviceID: publicKey(key), token: token, environment: environment)
                guard try await account.pushRegistrationAvailable(requireDelivery: true) else {
                    throw HubAccountError.rejected(503)
                }
                _ = try await account.registerPush(registration)
                guard generation == notificationEpoch, epoch == accountEpoch, notificationsWanted, accountSignedIn else { return }
                notificationsRegistered = true; notificationsError = nil
            } catch {
                guard generation == notificationEpoch, epoch == accountEpoch else { return }
                notificationsRegistered = false; notificationsError = "通知连接未完成，请重试"
            }
        }
    }

    func pushRegistrationFailed() {
        notificationEpoch += 1
        notificationsRegistered = false
        if notificationsWanted { notificationsError = "通知暂不可用，请稍后重试" }
    }

    private func restoreNotifications() async {
        notificationsWanted = UserDefaults.standard.bool(forKey: notificationPreference)
        notificationsRevocationPending = UserDefaults.standard.bool(forKey: notificationPreference + ".revoke")
        if notificationsRevocationPending { await disableNotifications(); return }
        guard notificationsWanted, accountSignedIn,
              let raw = Bundle.main.object(forInfoDictionaryKey: "MiaoPushEnvironment") as? String,
              PushEnvironment(rawValue: raw) != nil else { return }
        let epoch = accountEpoch
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard epoch == accountEpoch, accountSignedIn, notificationsWanted else { return }
        if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
        } else if settings.authorizationStatus == .denied {
            await disableNotifications()
            if !notificationsRevocationPending { notificationsError = "请在系统设置中允许 miao 通知" }
        } else { notificationsRegistered = false }
    }

    func load() async {
        if let loadTask { await loadTask.value; return }
        let task = Task { await initialize() }
        loadTask = task
        await task.value
        loadTask = nil
    }

    private func initialize() async {
        do {
            if !accountLoaded {
                accountLoaded = true
                await restoreAccount()
            }
            let key = try await identity.loadOrCreate()
            if registry == nil { registry = try HostRegistry(directory: directory, deviceKey: publicKey(key), allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP) }
            try await reload()
            await restoreNotifications()
        } catch { self.error = userMessage(error) }
    }

    private func reload() async throws {
        guard let registry else { return }
        reloadEpoch += 1
        let generation = reloadEpoch
        let snapshot = try await registry.snapshot()
        guard generation == reloadEpoch else { return }
        hosts = snapshot.hosts
        attempts = snapshot.attempts
        for record in hosts where clients[record.id] == nil {
            clients[record.id] = try HostClient(record: record, identity: identity, directory: directory.appendingPathComponent("checkpoints"), account: accountFor(record.host.hubURL))
        }
    }

    func pair(_ uri: String, label: String) {
        guard pairTask == nil, let registry else { return }
        let invitation: PairingInvitation
        do { invitation = try PairingInvitation.parse(uri, allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP) }
        catch { self.error = userMessage(error); return }
        guard accountSignedIn || AppTestConfiguration.allowLegacyTransport else {
            error = "请先登录电脑使用的中继，再扫码配对"; return
        }
        error = nil; fingerprint = nil; pairing = "正在连接电脑…"
        pairTask = Task {
            do {
                try await registry.begin(invitation)
                let paired = try await HubConnection.pair(invitation: invitation, identity: identity.loadOrCreate(),
                    label: label,
                    allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP, account: account,
                    pending: { [weak self] value in await self?.pending(value) },
                    persist: { host, grant in try await registry.approve(host: host, grant: grant, pairingID: invitation.pairingID) },
                    reconcile: { _ in throw RemoteRPCError.disconnected })
                // The shared scene coordinator owns normal connections, not this temporary pairing sheet.
                await paired.connection.close()
                try await reload()
                pairing = nil; fingerprint = nil
            } catch is CancellationError { pairing = nil }
            catch { self.error = userMessage(error); pairing = nil; try? await reload() }
            pairTask = nil
        }
    }

    private var accountPreference: String { AppTestConfiguration.runID.map { "miao.remote.ui-test-origin." + $0 } ?? "miao.remote.hub-origin" }
    private var accountService: String { AppTestConfiguration.runID.map { "miao.remote.ui-test-account." + $0 } ?? "miao.remote.hub-account" }

    private func accountFor(_ url: URL) -> HubAccount? {
        guard accountSignedIn, let accountOrigin,
              let left = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let right = URLComponents(url: accountOrigin, resolvingAgainstBaseURL: false),
              left.scheme?.lowercased() == right.scheme?.lowercased(),
              left.host?.lowercased() == right.host?.lowercased(),
              (left.port ?? (left.scheme?.lowercased() == "https" ? 443 : 80))
                == (right.port ?? (right.scheme == "https" ? 443 : 80)) else { return nil }
        return account
    }

    private func restoreAccount() async {
        guard let saved = UserDefaults.standard.string(forKey: accountPreference), let url = URL(string: saved) else { return }
        accountURL = saved
        accountBusy = true
        defer { accountBusy = false }
        do {
            let restored = try HubAccount(origin: url, keychainService: accountService, allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP)
            account = restored; accountOrigin = await restored.origin
            accountSignedIn = try await restored.restore()
            if accountSignedIn { await refreshDirectory() }
        } catch { accountError = "中继登录未恢复，请重新登录" }
    }

    func signIn(origin: String, email: String, password: String) async {
        guard !accountBusy else { return }
        accountBusy = true; accountError = nil
        accountEpoch += 1
        let generation = accountEpoch
        defer { if generation == accountEpoch { accountBusy = false } }
        do {
            guard let url = URL(string: origin.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw HubAccountError.invalidEndpoint }
            let next = try HubAccount(origin: url, keychainService: accountService, allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP)
            accountSignedIn = false; discoveredHosts = []
            let pendingPair = pairTask
            pendingPair?.cancel(); await pendingPair?.value
            for client in clients.values { await client.close() }
            clients.removeAll()
            if let account { try await account.signOut(); await account.close() }
            // Restore only to revoke this device's previous stored session before replacing it.
            if try await next.restore() { try await next.signOut() }
            try await next.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            guard generation == accountEpoch else { try? await next.signOut(); await next.close(); return }
            let canonical = await next.origin
            account = next; accountOrigin = canonical
            accountURL = canonical.absoluteString
            accountSignedIn = true; revocationPending = false
            UserDefaults.standard.set(accountURL, forKey: accountPreference)
            try await reload()
            connectionEpoch += 1
            await refreshDirectory()
            await restoreNotifications()
        } catch {
            if generation == accountEpoch {
                accountError = accountMessage(error)
                try? await reload()
                connectionEpoch += 1
            }
        }
    }

    /// Sign in through the hub's OAuth provider (mhub has no password). The
    /// browser returns to the app's own scheme with a one-time code.
    func signInWithOAuth(provider: String) async {
        guard !accountBusy else { return }
        accountBusy = true; accountError = nil
        accountEpoch += 1
        let generation = accountEpoch
        defer { if generation == accountEpoch { accountBusy = false } }
        do {
            let raw = (accountURL.isEmpty ? defaultAccountURL : accountURL).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: raw) else { throw HubAccountError.invalidEndpoint }
            let next = try HubAccount(origin: url, keychainService: accountService, allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP)
            accountSignedIn = false; discoveredHosts = []
            let pendingPair = pairTask
            pendingPair?.cancel(); await pendingPair?.value
            for client in clients.values { await client.close() }
            clients.removeAll()
            if let account { try await account.signOut(); await account.close() }
            if try await next.restore() { try await next.signOut() }
            let authorize = try await next.oauthAuthorizeURL(provider: provider, callbackURL: "miao://auth")
            let code = try await Self.presentOAuth(url: authorize, scheme: "miao")
            try await next.signInWithOAuth(code: code)
            guard generation == accountEpoch else { try? await next.signOut(); await next.close(); return }
            let canonical = await next.origin
            account = next; accountOrigin = canonical
            accountURL = canonical.absoluteString
            accountSignedIn = true; revocationPending = false
            UserDefaults.standard.set(accountURL, forKey: accountPreference)
            try await reload()
            connectionEpoch += 1
            await refreshDirectory()
            await restoreNotifications()
        } catch {
            if generation == accountEpoch {
                accountError = accountMessage(error)
                try? await reload()
                connectionEpoch += 1
            }
        }
    }

    private static func presentOAuth(url: URL, scheme: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                if let error { continuation.resume(throwing: error); return }
                guard let callback,
                      let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
                      let code = components.queryItems?.first(where: { $0.name == "code" })?.value else {
                    continuation.resume(throwing: HubAccountError.malformed); return
                }
                continuation.resume(returning: code)
            }
            session.presentationContextProvider = OAuthPresentationAnchor.shared
            session.prefersEphemeralWebBrowserSession = false
            if !session.start() { continuation.resume(throwing: HubAccountError.authenticationRequired) }
        }
    }

    func signOut() async {
        guard !accountBusy else { return }
        accountBusy = true; accountEpoch += 1
        notificationOpenTask?.cancel()
        notificationHostID = nil; notificationDestination = nil
        accountSignedIn = false; discoveredHosts = []
        notificationEpoch += 1; notificationsRegistered = false
        UIApplication.shared.unregisterForRemoteNotifications()
        AppNotifications.shared.forget()
        await pushTask?.value
        let pendingPair = pairTask
        pendingPair?.cancel(); await pendingPair?.value
        for client in clients.values { await client.close() }
        clients.removeAll()
        do { try await account?.signOut(); accountError = nil; revocationPending = false }
        catch { revocationPending = true; accountError = "已从本机退出。中继撤销未确认，请联网后再次退出登录" }
        // Keep the account actor to allow an explicit retry of uncertain remote revocation.
        try? await reload()
        connectionEpoch += 1
        accountBusy = false
    }

    func refreshDirectory() async {
        guard accountSignedIn, let account else { return }
        let generation = accountEpoch
        do {
            let hosts = try await account.hosts()
            guard generation == accountEpoch, accountSignedIn else { return }
            discoveredHosts = hosts; accountError = nil
        } catch {
            guard generation == accountEpoch else { return }
            accountError = accountMessage(error)
            if error as? HubAccountError == .authenticationRequired {
                accountSignedIn = false; discoveredHosts = []
                for client in clients.values { await client.close() }
                connectionEpoch += 1
            }
        }
    }

    private func accountMessage(_ error: Error) -> String {
        switch error {
        case HubAccountError.invalidEndpoint: return "请输入电脑配置的 HTTPS 中继地址"
        case HubAccountError.authenticationRequired: return "登录已失效，请重新登录中继"
        case HubAccountError.invalidCredentials, HubAccountError.rejected(401), HubAccountError.rejected(403): return "登录未成功，请核对邮箱、密码和中继地址"
        case HubAccountError.storage: return "设备凭证暂时不可用，请解锁后重试"
        default: return "暂时无法连接中继，请检查网络后重试"
        }
    }

    private func pending(_ value: String) { fingerprint = value; pairing = "请在电脑上核对指纹并批准" }
    func cancelPairing() { pairTask?.cancel() }

    func scene(_ id: UUID, phase: ScenePhase) {
        scenes[id] = phase
        if phase == .active, !notificationsBusy { Task { await restoreNotifications() } }
        if scenes.values.allSatisfy({ $0 == .background }) { cancelPairing() }
    }

    func removeScene(_ id: UUID) {
        scenes.removeValue(forKey: id)
        if scenes.values.allSatisfy({ $0 == .background }) { cancelPairing() }
    }

    func forget(_ id: UUID) async {
        do {
            await clients[id]?.close()
            try await clients[id]?.store.clear()
            try await registry?.forget(id)
            clients[id] = nil
            try await reload()
        } catch { self.error = userMessage(error) }
    }
}

struct SessionSummary: Identifiable {
    let id: String
    let title: String
    let projectID: String
    init?(_ value: JSONValue) {
        guard let id = value["id"]?.string, let title = value["title"]?.string, let projectID = value["projectID"]?.string else { return nil }
        self.id = id; self.title = title; self.projectID = projectID
    }
}

struct NotificationDestination: Identifiable {
    let id = UUID()
    let hostID: UUID
    let summary: SessionSummary
}

@MainActor @Observable
final class HostClient {
    let record: AuthorizedHost
    let identity: DeviceIdentity
    let scope: AuthorizationScope
    let store: CheckpointStore
    var state: RemoteConnectionState = .quiescent
    var projects: [JSONValue] = []
    var lists: [String: [SessionSummary]] = [:]
    var next: [String: String] = [:]
    var sessions: [String: RemoteSession] = [:]
    var operations: [PendingOperation] = []
    var error: String?
    var sendingTargets = Set<String>()
    private(set) var runtimeID: String
    private var connection: HubConnection?
    private let account: HubAccount?
    private var observer: Task<Void, Never>?
    private var sceneIDs = Set<UUID>()
    private var closed = false
    private var writes = 0
    private var coordinator: ConnectionCoordinator!
    var ready: Bool { state == .ready && !record.expired && !closed }
    var connectionDescription: String {
        if record.expired { return "授权已过期，请在电脑上重新配对" }
        switch state {
        case .ready: return "已连接"
        case .connecting: return "正在连接…"
        case .syncing: return "正在同步会话…"
        case .authorizationBlocked: return "授权需要重新核对"
        case .protocolBlocked: return "请更新电脑和 App 的版本"
        case .offline: return "离线，回到前台后会重新连接"
        case .draining: return "正在断开连接…"
        case .quiescent: return "等待连接"
        }
    }
    func sending(_ sessionID: String) -> Bool { sendingTargets.contains(sessionID) }

    init(record: AuthorizedHost, identity: DeviceIdentity, directory: URL, account: HubAccount? = nil) throws {
        self.record = record; self.identity = identity; self.account = account
        runtimeID = record.host.target.runtimeID
        scope = AuthorizationScope(deviceID: record.grant.publicKey, grantID: record.grant.id, hostID: record.host.target.hostID)
        store = try CheckpointStore(directory: directory, scope: scope)
        coordinator = ConnectionCoordinator { [weak self] in
            guard let self else { throw RemoteRPCError.disconnected }
            return try await self.connect()
        }
        observer = Task { [weak self, coordinator] in
            guard let coordinator else { return }
            for await value in await coordinator.updates() {
                guard let self, !self.closed else { return }
                self.state = value
                if value == .ready { self.sessions.values.forEach { $0.resume() } }
                if value != .ready { self.sessions.values.forEach { $0.pause() } }
            }
        }
    }

    private func connect() async throws -> HubConnection {
        guard !record.expired, !closed, account != nil || AppTestConfiguration.allowLegacyTransport else {
            throw RemoteConnectionError.authorizationBlocked
        }
        let opened = try await HubConnection.open(host: record.host, identity: identity.loadOrCreate(), allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP, account: account) { [weak self] connection in
            guard let self else { throw RemoteRPCError.disconnected }
            try await self.synchronize(connection)
        }
        if closed { await opened.close(); throw RemoteRPCError.disconnected }
        let target = await opened.target
        guard !closed else { await opened.close(); throw RemoteRPCError.disconnected }
        runtimeID = target.runtimeID
        sessions.values.forEach { $0.updateRuntime(target.runtimeID) }
        connection = opened
        return opened
    }

    private func synchronize(_ connection: HubConnection) async throws {
        guard !closed else { throw CancellationError() }
        writes += 1
        defer { writes -= 1 }
        // Query uncertain operations with their original IDs and payloads. Never resend them here.
        for operation in try await store.reconciliation() {
            let result = try await connection.request(.operationGet, sessionID: operation.target.sessionID,
                projectID: operation.target.projectID, payload: .object(["operationID": .string(operation.id.uuidString.lowercased())]))
            guard !closed else { throw CancellationError() }
            if let status = operationStatus(result["status"]?.string) {
                try await store.resolve(operation.id, status: status, result: JSONEncoder().encode(result))
            }
        }
        operations = try await store.snapshot().operations
        let projects = try await connection.request(.projectList)
        guard !closed else { throw CancellationError() }
        guard let data = projects["data"]?.array else { throw RemoteConnectionError.protocolIncompatible }
        self.projects = data
        if record.grant.sessionIDs.count > 0 { try await loadList(nil, connection: connection) }
        for project in record.grant.projectIDs { try await loadList(project, connection: connection) }
    }

    func scene(_ id: UUID, phase: ScenePhase) async {
        guard !closed else { return }
        sceneIDs.insert(id)
        await coordinator.scene(id, phase: phase == .active ? .active : phase == .inactive ? .inactive : .background)
    }

    func removeScene(_ id: UUID) async { sceneIDs.remove(id); await coordinator.removeScene(id) }

    func close() async {
        closed = true; observer?.cancel()
        for id in sceneIDs { await coordinator.removeScene(id) }
        await connection?.close()
        for session in sessions.values { await session.drain() }
        while writes > 0 { try? await Task.sleep(for: .milliseconds(20)) }
        state = .quiescent
    }

    func request(_ method: RemoteMethod, sessionID: String? = nil, projectID: String? = nil,
                 payload: JSONValue = .object([:])) async throws -> JSONValue {
        guard ready, let connection else { throw RemoteRPCError.disconnected }
        return try await connection.request(method, sessionID: sessionID, projectID: projectID, payload: payload)
    }

    private func loadList(_ project: String?, connection: HubConnection, more: Bool = false) async throws {
        let key = project ?? ""
        var payload: [String: JSONValue] = ["limit": .number(100)]
        if more, let cursor = next[key] { payload["cursor"] = .string(cursor) }
        let result = try await connection.request(.sessionList, projectID: project, payload: .object(payload))
        guard !closed else { throw CancellationError() }
        guard let data = result["data"]?.array else { throw RemoteConnectionError.protocolIncompatible }
        let values = data.compactMap(SessionSummary.init)
        guard values.count == data.count else { throw RemoteConnectionError.protocolIncompatible }
        lists[key] = more ? (lists[key] ?? []) + values : values
        next[key] = result["cursor"]?["next"]?.string
    }

    func refreshLists(more: String? = nil) async {
        guard ready, let connection else { return }
        do {
            if let more { try await loadList(more.isEmpty ? nil : more, connection: connection, more: true); return }
            if record.grant.sessionIDs.count > 0 { try await loadList(nil, connection: connection) }
            for project in record.grant.projectIDs { try await loadList(project, connection: connection) }
        } catch { self.error = userMessage(error) }
    }

    func reconcileOperations() async {
        guard ready, let connection else { return }
        writes += 1
        defer { writes -= 1 }
        do {
            for operation in try await store.reconciliation() {
                let result = try await connection.request(.operationGet, sessionID: operation.target.sessionID,
                    projectID: operation.target.projectID, payload: .object(["operationID": .string(operation.id.uuidString.lowercased())]))
                guard !closed else { throw CancellationError() }
                if let status = operationStatus(result["status"]?.string) {
                    try await store.resolve(operation.id, status: status, result: JSONEncoder().encode(result))
                }
            }
            operations = try await store.snapshot().operations
        } catch { self.error = userMessage(error) }
    }

    func session(_ summary: SessionSummary) -> RemoteSession {
        if let value = sessions[summary.id] { return value }
        let value = RemoteSession(summary: summary, client: self)
        sessions[summary.id] = value
        return value
    }

    @discardableResult
    func mutate(_ method: RemoteMethod, kind: OperationKind, target: OperationTarget, payload: JSONValue) async throws -> JSONValue {
        let key = target.sessionID ?? "project:" + (target.projectID ?? "")
        guard ready, !sendingTargets.contains(key), let connection else { throw RemoteRPCError.disconnected }
        writes += 1; sendingTargets.insert(key)
        defer { writes -= 1; sendingTargets.remove(key) }
        let operation = PendingOperation(scope: scope, target: target, kind: kind, payload: try JSONEncoder().encode(payload))
        try await store.prepare(operation)
        if closed { throw CancellationError() }
        try await store.markSending(operation.id)
        do {
            let result = try await connection.request(method, sessionID: target.sessionID, projectID: target.projectID,
                                                      operationID: operation.id, payload: payload)
            guard let status = operationStatus(result["status"]?.string) else { throw RemoteConnectionError.protocolIncompatible }
            try await store.resolve(operation.id, status: status, result: JSONEncoder().encode(result))
            operations = try await store.snapshot().operations
            if status == .rejected || status == .outcomeUnknown { throw RemoteRPCError.rejected(result["code"]?.string ?? "uncertain") }
            return result
        } catch {
            operations = (try? await store.snapshot().operations) ?? operations
            throw error
        }
    }
}

@MainActor @Observable
final class RemoteSession {
    let summary: SessionSummary
    private weak var client: HostClient?
    private var address: SessionAddress
    var timeline = SessionTimeline()
    private var live: LiveSessionProjection?
    var visibleMessages: [JSONValue] { live?.displaying(timeline.messages) ?? timeline.messages }
    var pending: JSONValue = .object([:])
    var draft = ""
    var error: String?
    var loading = true
    var diff: JSONValue?
    private var viewers = 0
    private var poll: Task<Void, Never>?
    private var draftTail: Task<Void, Never>?
    private var epoch = 0
    private var draftRevision = 0

    init(summary: SessionSummary, client: HostClient) {
        self.summary = summary; self.client = client
        address = SessionAddress(hostID: client.record.host.target.hostID, runtimeID: client.runtimeID, sessionID: summary.id)
    }
    func updateRuntime(_ runtimeID: String) {
        guard address.runtimeID != runtimeID else { return }
        pause()
        address = SessionAddress(hostID: address.hostID, runtimeID: runtimeID, sessionID: address.sessionID)
        timeline = SessionTimeline(); pending = .object([:]); loading = true
        edit(draft)
    }
    func appear() { viewers += 1; resume() }
    func disappear() { viewers = max(0, viewers - 1); if viewers == 0 { pause() } }
    func pause() { epoch += 1; poll?.cancel(); live = nil }
    func drain() async { let old = poll; pause(); await old?.value; await draftTail?.value }

    func resume() {
        guard viewers > 0, poll == nil, let client, client.ready else { return }
        epoch += 1; let generation = epoch
        let revision = draftRevision
        let address = address
        poll = Task {
            defer {
                poll = nil
                if epoch != generation, viewers > 0, client.ready { resume() }
            }
            do {
                let checkpoint = try await client.store.snapshot()
                try Task.checkCancellation()
                guard epoch == generation else { return }
                if let saved = checkpoint.sessions.first(where: { $0.address == address }) {
                    let value = try JSONDecoder().decode(SessionTimeline.self, from: saved.state)
                    guard value.cursor == saved.cursor else { throw ClientStateError.invalidStorage }
                    timeline = value
                }
                if draftRevision == revision {
                    draft = checkpoint.drafts.first(where: { $0.address == address })?.text
                        ?? checkpoint.drafts.last(where: { $0.address.hostID == address.hostID && $0.address.sessionID == address.sessionID })?.text
                        ?? draft
                }
                while !Task.isCancelled, epoch == generation, client.ready {
                    let page = try await client.request(.sessionEvents, sessionID: summary.id, payload: .object([
                        "after": .number(Double(timeline.cursor)), "limit": .number(100), "waitMs": .number(1000)]))
                    try Task.checkCancellation()
                    guard epoch == generation else { return }
                    let projection = try LiveSessionProjection(page["live"])
                    var next = timeline
                    try next.apply(page, sessionID: summary.id)
                    if next.cursor != timeline.cursor {
                        try await client.store.save(SessionCheckpoint(address: address, state: JSONEncoder().encode(next), cursor: next.cursor))
                        guard epoch == generation else { return }
                        timeline = next
                    }
                    live = projection
                    loading = page["hasMore"]?.bool == true
                    if !loading {
                        let value = try await client.request(.sessionPending, sessionID: summary.id)
                        guard epoch == generation else { return }
                        pending = value
                    }
                }
            } catch is CancellationError {}
            catch { if epoch == generation { live = nil; self.error = userMessage(error) } }
        }
    }

    func edit(_ text: String) {
        guard let client else { return }
        draftRevision += 1
        draft = text
        let previous = draftTail
        let captured = Draft(address: address, text: text)
        draftTail = Task {
            await previous?.value
            do { try await client.store.save(captured) }
            catch { self.error = userMessage(error) }
        }
    }

    func send(queue: Bool) async {
        guard client != nil, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let text = draft
        let accepted = await command(.sessionPrompt, kind: .prompt, payload: .object(["text": .string(text), "delivery": .string(queue ? "queue" : "steer")]))
        if accepted && draft == text { edit("") }
    }

    @discardableResult
    func command(_ method: RemoteMethod, kind: OperationKind, payload: JSONValue) async -> Bool {
        guard let client else { return false }
        error = nil
        do {
            _ = try await client.mutate(method, kind: kind, target: OperationTarget(session: address), payload: payload)
            return true
        } catch { self.error = userMessage(error); return false }
    }

    func loadDiff() async {
        do { diff = try await client?.request(.sessionDiff, sessionID: summary.id) }
        catch { self.error = userMessage(error) }
    }
}

private func publicKey(_ key: P256.Signing.PrivateKey) -> String {
    key.publicKey.x963Representation.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
private func operationStatus(_ value: String?) -> OperationStatus? {
    switch value { case "accepted": .accepted; case "completed": .completed; case "rejected": .rejected; case "outcome_unknown": .outcomeUnknown; default: nil }
}
func userMessage(_ error: Error) -> String {
    if error is PairingError { return "配对未完成或授权结果待核对，请在电脑上检查设备状态" }
    if error is ClientStateError { return "设备数据无法读取或保存，请解锁设备后重试" }
    if error is RemoteConnectionError { return "授权或协议需要核对，请检查电脑上的设备接入状态" }
    if case RemoteRPCError.rejected(let code) = error {
        return code == "uncertain" ? "操作结果待核对，不会自动重新发送" : "状态或授权已更新，请刷新后再试"
    }
    return "连接暂时不可用，已保留输入，请重新连接后核对结果"
}

private final class OAuthPresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = OAuthPresentationAnchor()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
