import Foundation

public struct SessionAddress: Codable, Hashable, Sendable {
    public let hostID: String
    public let runtimeID: String
    public let sessionID: String

    public init(hostID: String, runtimeID: String, sessionID: String) {
        self.hostID = hostID
        self.runtimeID = runtimeID
        self.sessionID = sessionID
    }
}

/// One cache partition per local device identity and Agent-issued grant.
public struct AuthorizationScope: Codable, Hashable, Sendable {
    public let deviceID: String
    public let grantID: String
    public let hostID: String

    public init(deviceID: String, grantID: String, hostID: String) {
        self.deviceID = deviceID
        self.grantID = grantID
        self.hostID = hostID
    }
}

public enum OperationKind: String, Codable, Sendable {
    case prompt, sessionCreate, permissionReply, questionReply, interrupt
}

public enum OperationStatus: String, Codable, Sendable {
    case prepared, awaitingConfirmation, accepted, completed, rejected, outcomeUnknown, expired
}

public struct PendingOperation: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID
    public let scope: AuthorizationScope
    public let address: SessionAddress
    public let kind: OperationKind
    /// Serialized immutable wire parameters, protected with the rest of the checkpoint.
    public let payload: Data
    public let createdAt: Date
    public private(set) var status: OperationStatus
    public private(set) var result: Data?

    public init(id: UUID = UUID(), scope: AuthorizationScope, address: SessionAddress,
                kind: OperationKind, payload: Data, createdAt: Date = Date()) {
        self.id = id
        self.scope = scope
        self.address = address
        self.kind = kind
        self.payload = payload
        self.createdAt = createdAt
        self.status = .prepared
    }

    mutating func transition(_ status: OperationStatus, result: Data?) throws {
        let terminal: Set<OperationStatus> = [.completed, .rejected, .expired]
        guard !terminal.contains(self.status) || self.status == status else { throw ClientStateError.invalidTransition }
        guard self.status != .accepted || status == .accepted || status == .completed else {
            throw ClientStateError.invalidTransition
        }
        guard status != .prepared else { throw ClientStateError.invalidTransition }
        self.status = status
        self.result = result ?? self.result
    }
}

public struct SessionCheckpoint: Codable, Sendable, Equatable {
    public let address: SessionAddress
    /// State and cursor are one atomic checkpoint; sequence numbers need not be contiguous.
    public let state: Data
    public let cursor: Int64
    public let updatedAt: Date

    public init(address: SessionAddress, state: Data, cursor: Int64, updatedAt: Date = Date()) {
        self.address = address
        self.state = state
        self.cursor = cursor
        self.updatedAt = updatedAt
    }
}

public struct Draft: Codable, Sendable, Equatable {
    public let address: SessionAddress
    public let text: String
    public init(address: SessionAddress, text: String) {
        self.address = address
        self.text = text
    }
}

public struct ClientCheckpoint: Codable, Sendable, Equatable {
    public let version: Int
    public let scope: AuthorizationScope
    public var operations: [PendingOperation]
    public var sessions: [SessionCheckpoint]
    public var drafts: [Draft]

    public init(scope: AuthorizationScope) {
        version = 1
        self.scope = scope
        operations = []
        sessions = []
        drafts = []
    }

    func validate() throws {
        guard version == 1 else { throw ClientStateError.incompatibleCheckpoint }
        guard operations.count <= 1024, sessions.count <= 256, drafts.count <= 256,
              Set(operations.map(\.id)).count == operations.count,
              Set(sessions.map(\.address)).count == sessions.count,
              Set(drafts.map(\.address)).count == drafts.count else { throw ClientStateError.limitExceeded }
        guard operations.allSatisfy({ $0.scope == scope && $0.address.hostID == scope.hostID }),
              sessions.allSatisfy({ $0.address.hostID == scope.hostID && $0.cursor >= 0 }),
              drafts.allSatisfy({ $0.address.hostID == scope.hostID }) else { throw ClientStateError.scopeMismatch }
    }
}

public enum ClientStateError: Error, Equatable {
    case scopeMismatch, incompatibleCheckpoint, limitExceeded, operationConflict
    case operationMissing, invalidTransition, staleCursor, invalidStorage, identityUnavailable(Int32)
}
