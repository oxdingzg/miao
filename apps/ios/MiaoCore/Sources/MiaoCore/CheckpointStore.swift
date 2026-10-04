import Foundation
import CryptoKit

/// All callers, including multiple iPad windows, share this actor.
/// Writes complete before an operation may be transmitted or a cursor exposed.
public actor CheckpointStore {
    private let file: URL
    private let scope: AuthorizationScope
    private var checkpoint: ClientCheckpoint?
    private let maximumBytes = 16 * 1024 * 1024

    public init(directory: URL, scope: AuthorizationScope) throws {
        guard directory.isFileURL else { throw ClientStateError.invalidStorage }
        self.scope = scope
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let key = try encoder.encode(scope)
        let name = SHA256.hash(data: key).map { String(format: "%02x", $0) }.joined()
        file = directory.appendingPathComponent(name + ".json")
    }

    public func snapshot() throws -> ClientCheckpoint { try load() }

    @discardableResult
    public func prepare(_ operation: PendingOperation) throws -> PendingOperation {
        guard operation.scope == scope, operation.address.hostID == scope.hostID else {
            throw ClientStateError.scopeMismatch
        }
        var next = try load()
        if let existing = next.operations.first(where: { $0.id == operation.id }) {
            guard existing.scope == operation.scope, existing.address == operation.address,
                  existing.kind == operation.kind, existing.payload == operation.payload else {
                throw ClientStateError.operationConflict
            }
            return existing
        }
        guard operation.status == .prepared else { throw ClientStateError.invalidTransition }
        next.operations.append(operation)
        try persist(next)
        return operation
    }

    /// Invoke before socket.send, including on the very first attempt.
    /// A crash after this write is resolved by operation.get, never a fresh ID.
    public func markSending(_ id: UUID) throws {
        var next = try load()
        guard let index = next.operations.firstIndex(where: { $0.id == id }) else {
            throw ClientStateError.operationMissing
        }
        guard next.operations[index].status == .prepared else { throw ClientStateError.invalidTransition }
        try next.operations[index].transition(.awaitingConfirmation, result: nil)
        try persist(next)
    }

    public func resolve(_ id: UUID, status: OperationStatus, result: Data? = nil) throws {
        var next = try load()
        guard let index = next.operations.firstIndex(where: { $0.id == id }) else {
            throw ClientStateError.operationMissing
        }
        try next.operations[index].transition(status, result: result)
        try persist(next)
    }

    /// Even prepared operations may have reached the host before the process died.
    /// This API returns items to query, not an automatic retransmission queue.
    public func reconciliation() throws -> [PendingOperation] {
        try load().operations.filter { [.prepared, .awaitingConfirmation, .outcomeUnknown].contains($0.status) }
    }

    public func save(_ session: SessionCheckpoint) throws {
        guard session.address.hostID == scope.hostID, session.cursor >= 0 else {
            throw ClientStateError.scopeMismatch
        }
        var next = try load()
        if let index = next.sessions.firstIndex(where: { $0.address == session.address }) {
            guard session.cursor >= next.sessions[index].cursor else { throw ClientStateError.staleCursor }
            next.sessions[index] = session
        } else {
            next.sessions.append(session)
        }
        try persist(next)
    }

    public func save(_ draft: Draft) throws {
        guard draft.address.hostID == scope.hostID else { throw ClientStateError.scopeMismatch }
        var next = try load()
        next.drafts.removeAll { $0.address == draft.address }
        if !draft.text.isEmpty { next.drafts.append(draft) }
        try persist(next)
    }

    public func clear() throws {
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        checkpoint = ClientCheckpoint(scope: scope)
    }

    private func load() throws -> ClientCheckpoint {
        if let checkpoint { return checkpoint }
        guard FileManager.default.fileExists(atPath: file.path) else {
            let empty = ClientCheckpoint(scope: scope)
            checkpoint = empty
            return empty
        }
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= maximumBytes else { throw ClientStateError.invalidStorage }
        let saved = try JSONDecoder().decode(ClientCheckpoint.self, from: Data(contentsOf: file))
        guard saved.scope == scope else { throw ClientStateError.scopeMismatch }
        try saved.validate()
        checkpoint = saved
        return saved
    }

    private func persist(_ next: ClientCheckpoint) throws {
        try next.validate()
        let data = try JSONEncoder().encode(next)
        guard data.count <= maximumBytes else { throw ClientStateError.limitExceeded }
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(".checkpoint-" + UUID().uuidString)
        #if os(iOS)
        let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600, .protectionKey: FileProtectionType.complete]
        #else
        let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #endif
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil, attributes: attributes) else {
            throw ClientStateError.invalidStorage
        }
        defer { try? FileManager.default.removeItem(at: temporary) }
        var excluded = temporary
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        let handle = try FileHandle(forWritingTo: temporary)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        if FileManager.default.fileExists(atPath: file.path) {
            _ = try FileManager.default.replaceItemAt(file, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: file)
        }
        checkpoint = next
    }
}
