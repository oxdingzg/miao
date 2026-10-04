import Foundation

public enum RemoteConnectionState: String, Sendable {
    case quiescent, connecting, syncing, ready, offline, draining, authorizationBlocked, protocolBlocked
}

public enum ClientScenePhase: Sendable { case active, inactive, background }
public enum RemoteConnectionError: Error { case authorizationBlocked, protocolIncompatible }

public protocol ClientConnection: Sendable {
    /// Revalidate authorization and reconcile the operation ledger before becoming ready.
    func synchronize() async throws
    /// Close only transport resources. Never interrupt a host execution here.
    func close() async
    func waitForDisconnect() async throws
}

/// Shared by every scene for one signed-in Hub identity.
/// Epochs fence callbacks from cancelled handshakes and background transitions.
public actor ConnectionCoordinator {
    public typealias Connect = @Sendable () async throws -> any ClientConnection
    private let connect: Connect
    private var scenes: [UUID: ClientScenePhase] = [:]
    private var epoch: UInt64 = 0
    private var connection: (any ClientConnection)?
    private var task: Task<Void, Never>?
    private var attempts = 0
    private var observers: [UUID: AsyncStream<RemoteConnectionState>.Continuation] = [:]
    public private(set) var state: RemoteConnectionState = .quiescent

    public init(connect: @escaping Connect) { self.connect = connect }

    public func updates() -> AsyncStream<RemoteConnectionState> {
        let id = UUID()
        let stream = AsyncStream<RemoteConnectionState>(bufferingPolicy: .bufferingNewest(1)) { continuation in
            observers[id] = continuation
            continuation.yield(state)
            continuation.onTermination = { @Sendable _ in
                Task { await self.removeObserver(id) }
            }
        }
        return stream
    }

    public func scene(_ id: UUID, phase: ClientScenePhase) {
        scenes[id] = phase
        if scenes.values.allSatisfy({ $0 == .background }) {
            quiesce()
            return
        }
        // Inactive alone never starts a connection, but keeps an existing one alive.
        if phase == .active, state == .quiescent || state == .offline || state == .draining { start() }
    }

    public func removeScene(_ id: UUID) {
        scenes.removeValue(forKey: id)
        if scenes.values.allSatisfy({ $0 == .background }) { quiesce() }
    }

    public func retry() {
        guard scenes.values.contains(.active), state == .offline else { return }
        start()
    }

    /// Called only after explicit successful re-pairing/unlock, never by retry().
    public func authorizationRestored() {
        guard state == .authorizationBlocked else { return }
        setState(.quiescent)
        if scenes.values.contains(.active) { start() }
    }

    public func authorizationRevoked() {
        stop(next: .authorizationBlocked)
    }

    private func start() {
        epoch &+= 1
        let current = epoch
        task?.cancel()
        setState(.connecting)
        task = Task {
            do {
                let opened = try await connect()
                guard accept(opened, epoch: current) else {
                    await opened.close()
                    return
                }
                do {
                    try await opened.synchronize()
                    try Task.checkCancellation()
                    finished(opened, epoch: current)
                } catch {
                    await opened.close()
                    failed(error, epoch: current)
                }
            } catch {
                failed(error, epoch: current)
            }
        }
    }

    private func accept(_ opened: any ClientConnection, epoch current: UInt64) -> Bool {
        guard epoch == current, !Task.isCancelled else { return false }
        connection = opened
        setState(.syncing)
        return true
    }

    private func finished(_ opened: any ClientConnection, epoch current: UInt64) {
        guard epoch == current else { return }
        attempts = 0
        setState(.ready)
        task = Task {
            do {
                try await opened.waitForDisconnect()
                failed(CancellationError(), epoch: current)
            } catch { failed(error, epoch: current) }
        }
    }

    private func failed(_ error: Error, epoch current: UInt64) {
        guard epoch == current else { return }
        connection = nil
        task = nil
        if let reason = error as? RemoteConnectionError {
            setState(reason == .authorizationBlocked ? .authorizationBlocked : .protocolBlocked)
        } else {
            setState(.offline)
        }
        guard state == .offline, scenes.values.contains(.active) else { return }
        let delay = min(30.0, 0.5 * pow(2.0, Double(min(attempts, 6)))) * Double.random(in: 0.75...1.25)
        attempts += 1
        task = Task {
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard epoch == current, scenes.values.contains(.active), state == .offline else { return }
            start()
        }
    }

    private func quiesce() {
        guard state != .authorizationBlocked, state != .protocolBlocked,
              state != .quiescent, state != .draining else { return }
        stop(next: .draining)
    }

    private func stop(next: RemoteConnectionState) {
        epoch &+= 1
        let current = epoch
        task?.cancel()
        task = nil
        let closing = connection
        connection = nil
        setState(next)
        Task {
            await closing?.close()
            finishClosing(epoch: current, state: next)
        }
    }

    private func finishClosing(epoch current: UInt64, state closingState: RemoteConnectionState) {
        guard epoch == current, closingState == .draining else { return }
        setState(.quiescent)
    }

    private func setState(_ next: RemoteConnectionState) {
        state = next
        observers.values.forEach { $0.yield(next) }
    }

    private func removeObserver(_ id: UUID) { observers.removeValue(forKey: id) }
}
