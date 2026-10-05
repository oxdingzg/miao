import Foundation
import SwiftUI
import Observation
import CryptoKit
import MiaoCore

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
    private var registry: HostRegistry?
    private var pairTask: Task<Void, Never>?
    private var scenes: [UUID: ScenePhase] = [:]
    private var reloadEpoch = 0

    func load() async {
        do {
            let key = try await identity.loadOrCreate()
            if registry == nil { registry = try HostRegistry(directory: directory, deviceKey: publicKey(key), allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP) }
            try await reload()
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
            clients[record.id] = try HostClient(record: record, identity: identity, directory: directory.appendingPathComponent("checkpoints"))
        }
    }

    func pair(_ uri: String, label: String) {
        guard pairTask == nil, let registry else { return }
        error = nil; fingerprint = nil; pairing = "正在连接电脑…"
        pairTask = Task {
            do {
                let invitation = try PairingInvitation.parse(uri, allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP)
                try await registry.begin(invitation)
                let paired = try await HubConnection.pair(invitation: invitation, identity: identity.loadOrCreate(),
                    label: label,
                    allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP,
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

    private func pending(_ value: String) { fingerprint = value; pairing = "请在电脑上核对指纹并批准" }
    func cancelPairing() { pairTask?.cancel() }

    func scene(_ id: UUID, phase: ScenePhase) {
        scenes[id] = phase
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
    private var connection: HubConnection?
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

    init(record: AuthorizedHost, identity: DeviceIdentity, directory: URL) throws {
        self.record = record; self.identity = identity
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
        guard !record.expired, !closed else { throw RemoteConnectionError.authorizationBlocked }
        let opened = try await HubConnection.open(host: record.host, identity: identity.loadOrCreate(), allowLoopbackHTTP: AppTestConfiguration.allowLoopbackHTTP) { [weak self] connection in
            guard let self else { throw RemoteRPCError.disconnected }
            try await self.synchronize(connection)
        }
        if closed { await opened.close(); throw RemoteRPCError.disconnected }
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
    private let address: SessionAddress
    var timeline = SessionTimeline()
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
        address = SessionAddress(hostID: client.record.host.target.hostID, runtimeID: client.record.host.target.runtimeID, sessionID: summary.id)
    }
    func appear() { viewers += 1; resume() }
    func disappear() { viewers = max(0, viewers - 1); if viewers == 0 { pause() } }
    func pause() { epoch += 1; poll?.cancel() }
    func drain() async { let old = poll; pause(); await old?.value; await draftTail?.value }

    func resume() {
        guard viewers > 0, poll == nil, let client, client.ready else { return }
        epoch += 1; let generation = epoch
        let revision = draftRevision
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
                if draftRevision == revision { draft = checkpoint.drafts.first(where: { $0.address == address })?.text ?? draft }
                while !Task.isCancelled, epoch == generation, client.ready {
                    let page = try await client.request(.sessionEvents, sessionID: summary.id, payload: .object([
                        "after": .number(Double(timeline.cursor)), "limit": .number(100), "waitMs": .number(1000)]))
                    try Task.checkCancellation()
                    guard epoch == generation else { return }
                    var next = timeline
                    try next.apply(page, sessionID: summary.id)
                    if next.cursor != timeline.cursor {
                        try await client.store.save(SessionCheckpoint(address: address, state: JSONEncoder().encode(next), cursor: next.cursor))
                        guard epoch == generation else { return }
                        timeline = next
                    }
                    loading = page["hasMore"]?.bool == true
                    if !loading {
                        let value = try await client.request(.sessionPending, sessionID: summary.id)
                        guard epoch == generation else { return }
                        pending = value
                    }
                }
            } catch is CancellationError {}
            catch { if epoch == generation { self.error = userMessage(error) } }
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
