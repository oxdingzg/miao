import XCTest
import Foundation
@testable import MiaoCore

final class ClientStateTests: XCTestCase {
    private let scope = AuthorizationScope(deviceID: "device", grantID: "grant", hostID: "host")
    private let address = SessionAddress(hostID: "host", runtimeID: "runtime", sessionID: "session")

    func testRestartReconcilesStableOperationsWithoutRetransmission() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CheckpointStore(directory: directory, scope: scope)
        let operation = PendingOperation(scope: scope, address: address, kind: .prompt,
                                         payload: Data("{\"messageID\":\"stable\",\"text\":\"hello\"}".utf8))
        _ = try await store.prepare(operation)
        try await store.markSending(operation.id)
        let recovered = try CheckpointStore(directory: directory, scope: scope)
        let unknown = try await recovered.reconciliation()
        XCTAssertEqual(unknown.map(\.id), [operation.id])
        XCTAssertEqual(unknown.first?.status, .awaitingConfirmation)
        XCTAssertEqual(unknown.first?.payload, operation.payload)
        try await recovered.resolve(operation.id, status: .accepted, result: Data("receipt".utf8))
        let restarted = try CheckpointStore(directory: directory, scope: scope)
        let pending = try await restarted.reconciliation()
        XCTAssertTrue(pending.isEmpty)
        let checkpoint = try await restarted.snapshot()
        XCTAssertEqual(checkpoint.operations.first?.result, Data("receipt".utf8))
        do {
            try await restarted.markSending(operation.id)
            XCTFail("Accepted input cannot become a new transmission")
        } catch { XCTAssertEqual(error as? ClientStateError, .invalidTransition) }
    }

    func testPreparedApprovalIsQueriedAfterCrashAndConflictingRetryIsRejected() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CheckpointStore(directory: directory, scope: scope)
        let operation = PendingOperation(scope: scope, address: address, kind: .permissionReply, payload: Data([1]))
        _ = try await store.prepare(operation)
        let recovered = try CheckpointStore(directory: directory, scope: scope)
        let pending = try await recovered.reconciliation()
        XCTAssertEqual(pending.map(\.id), [operation.id])
        let conflict = PendingOperation(id: operation.id, scope: scope, address: address,
                                       kind: .permissionReply, payload: Data([2]))
        do {
            _ = try await recovered.prepare(conflict)
            XCTFail("Operation parameters must be immutable")
        } catch { XCTAssertEqual(error as? ClientStateError, .operationConflict) }
    }

    func testCheckpointAndCursorSurviveTogetherAndRuntimePartitionsStaySeparate() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CheckpointStore(directory: directory, scope: scope)
        try await store.save(SessionCheckpoint(address: address, state: Data("first".utf8), cursor: 10))
        let other = SessionAddress(hostID: "host", runtimeID: "other-runtime", sessionID: "session")
        try await store.save(SessionCheckpoint(address: other, state: Data("second".utf8), cursor: 30))
        let restarted = try CheckpointStore(directory: directory, scope: scope)
        let checkpoint = try await restarted.snapshot()
        XCTAssertEqual(checkpoint.sessions.count, 2)
        XCTAssertEqual(checkpoint.sessions.first?.state, Data("first".utf8))
        XCTAssertEqual(checkpoint.sessions.first?.cursor, 10)
        do {
            try await restarted.save(SessionCheckpoint(address: address, state: Data(), cursor: 9))
            XCTFail("An old callback cannot roll back the persisted cursor")
        } catch { XCTAssertEqual(error as? ClientStateError, .staleCursor) }
        let unchanged = try await restarted.snapshot()
        XCTAssertEqual(unchanged, checkpoint)
        let otherScope = AuthorizationScope(deviceID: "device", grantID: "other-grant", hostID: "host")
        let otherStore = try CheckpointStore(directory: directory, scope: otherScope)
        let isolated = try await otherStore.snapshot()
        XCTAssertTrue(isolated.sessions.isEmpty)
        try await restarted.clear()
        let cleared = try CheckpointStore(directory: directory, scope: scope)
        let empty = try await cleared.snapshot()
        XCTAssertTrue(empty.sessions.isEmpty)
    }

    func testHostScopeAndPrivateFiles() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CheckpointStore(directory: directory, scope: scope)
        let wrong = SessionAddress(hostID: "other-host", runtimeID: "runtime", sessionID: "session")
        do {
            try await store.save(Draft(address: wrong, text: "private"))
            XCTFail("A different host must not enter this cache")
        } catch { XCTAssertEqual(error as? ClientStateError, .scopeMismatch) }
        try await store.save(Draft(address: address, text: "saved"))
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        let attributes = try FileManager.default.attributesOfItem(atPath: files[0].path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    func testLegacySessionOperationMigratesAndProjectCreationHasNoInventedSessionID() async throws {
        let legacy = PendingOperation(scope: scope, address: address, kind: .prompt, payload: Data("hello".utf8))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as? [String: Any])
        object.removeValue(forKey: "target")
        object["address"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(address))
        let recovered = try JSONDecoder().decode(PendingOperation.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(recovered, legacy)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CheckpointStore(directory: directory, scope: scope)
        let target = OperationTarget(hostID: scope.hostID, runtimeID: "runtime", projectID: "project")
        let create = PendingOperation(scope: scope, target: target, kind: .sessionCreate, payload: Data("directory".utf8))
        try await store.prepare(create)
        let restarted = try CheckpointStore(directory: directory, scope: scope)
        let pending = try await restarted.reconciliation()
        XCTAssertEqual(pending.first?.target.projectID, "project")
        XCTAssertNil(pending.first?.target.sessionID)
        XCTAssertEqual(pending.first?.id, create.id)
    }

}
