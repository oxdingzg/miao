import XCTest
@testable import MiaoCore

private actor ControlledConnection: ClientConnection {
    var synchronized = false
    var closed = false
    private let blocked: Bool
    private let incompatible: Bool
    private var waiters: [CheckedContinuation<Void, Error>] = []
    init(blocked: Bool = false, incompatible: Bool = false) {
        self.blocked = blocked
        self.incompatible = incompatible
    }
    func synchronize() async throws {
        if blocked { throw RemoteConnectionError.authorizationBlocked }
        if incompatible { throw RemoteConnectionError.protocolIncompatible }
        synchronized = true
    }
    func close() async {
        closed = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
    func waitForDisconnect() async throws {
        if closed { return }
        try await withCheckedThrowingContinuation { waiters.append($0) }
    }
}

private actor ConnectionGate {
    private var continuation: CheckedContinuation<any ClientConnection, Never>?
    private var connections = 0
    func open() async -> any ClientConnection {
        connections += 1
        return await withCheckedContinuation { continuation = $0 }
    }
    func release(_ connection: any ClientConnection) {
        continuation?.resume(returning: connection)
        continuation = nil
    }
    func count() -> Int { connections }
}

final class ConnectionCoordinatorTests: XCTestCase {
    func testProtocolFailureCannotBeRetriedAsAnOrdinaryNetworkError() async throws {
        let gate = ConnectionGate()
        let coordinator = ConnectionCoordinator { await gate.open() }
        let scene = UUID()
        await coordinator.scene(scene, phase: .active)
        try await eventually { await gate.count() == 1 }
        await gate.release(ControlledConnection(incompatible: true))
        try await eventually { await coordinator.state == .protocolBlocked }
        await coordinator.retry()
        await coordinator.scene(scene, phase: .background)
        await coordinator.scene(scene, phase: .active)
        let count = await gate.count()
        XCTAssertEqual(count, 1)
        let state = await coordinator.state
        XCTAssertEqual(state, .protocolBlocked)
    }

    func testForegroundTransportLossReconnectsButBackgroundCancelsRecovery() async throws {
        let gate = ConnectionGate()
        let first = ControlledConnection()
        let coordinator = ConnectionCoordinator { await gate.open() }
        let scene = UUID()
        await coordinator.scene(scene, phase: .active)
        try await eventually { await gate.count() == 1 }
        await gate.release(first)
        try await eventually { await coordinator.state == .ready }
        await first.close()
        try await eventually { await gate.count() == 2 }
        await coordinator.scene(scene, phase: .background)
        let stale = ControlledConnection()
        await gate.release(stale)
        try await eventually { await stale.closed }
        let state = await coordinator.state
        XCTAssertEqual(state, .quiescent)
    }

    func testTwoScenesShareConnectionAndInactiveDoesNotDisconnect() async throws {
        let gate = ConnectionGate()
        let connection = ControlledConnection()
        let coordinator = ConnectionCoordinator { await gate.open() }
        let first = UUID()
        let second = UUID()
        await coordinator.scene(first, phase: .active)
        await coordinator.scene(second, phase: .active)
        try await eventually { await gate.count() == 1 }
        await gate.release(connection)
        try await eventually { await coordinator.state == .ready }
        await coordinator.scene(first, phase: .background)
        await coordinator.scene(second, phase: .inactive)
        let retained = await coordinator.state
        XCTAssertEqual(retained, .ready)
        let beforeBackground = await connection.closed
        XCTAssertFalse(beforeBackground)
        await coordinator.scene(second, phase: .background)
        try await eventually { await coordinator.state == .quiescent }
        let closed = await connection.closed
        XCTAssertTrue(closed)
        await coordinator.scene(first, phase: .active)
        try await eventually { await gate.count() == 2 }
        await gate.release(ControlledConnection())
        try await eventually { await coordinator.state == .ready }
        await coordinator.removeScene(first)
        await coordinator.removeScene(second)
        try await eventually { await coordinator.state == .quiescent }
    }

    func testCancelledHandshakeCannotReopenBackgroundConnection() async throws {
        let gate = ConnectionGate()
        let coordinator = ConnectionCoordinator { await gate.open() }
        let scene = UUID()
        await coordinator.scene(scene, phase: .active)
        try await eventually { await gate.count() == 1 }
        await coordinator.scene(scene, phase: .background)
        try await eventually { await coordinator.state == .quiescent }
        let stale = ControlledConnection()
        await gate.release(stale)
        try await eventually { await stale.closed }
        let synchronized = await stale.synchronized
        XCTAssertFalse(synchronized)
        let state = await coordinator.state
        XCTAssertEqual(state, .quiescent)
    }

    func testAuthorizationFailureStopsRetriesUntilExplicitRestoration() async throws {
        let gate = ConnectionGate()
        let coordinator = ConnectionCoordinator { await gate.open() }
        let scene = UUID()
        await coordinator.scene(scene, phase: .active)
        try await eventually { await gate.count() == 1 }
        await gate.release(ControlledConnection(blocked: true))
        try await eventually { await coordinator.state == .authorizationBlocked }
        await coordinator.retry()
        await coordinator.scene(scene, phase: .background)
        await coordinator.scene(scene, phase: .active)
        let count = await gate.count()
        XCTAssertEqual(count, 1)
        let state = await coordinator.state
        XCTAssertEqual(state, .authorizationBlocked)
        await coordinator.authorizationRestored()
        try await eventually { await gate.count() == 2 }
        await gate.release(ControlledConnection())
        try await eventually { await coordinator.state == .ready }
        await coordinator.removeScene(scene)
    }

    private func eventually(_ predicate: () async -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if await predicate() { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("State transition did not complete")
        throw CancellationError()
    }
}
