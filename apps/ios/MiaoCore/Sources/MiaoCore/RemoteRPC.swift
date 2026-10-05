import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([JSONValue].self) { self = .array(value); return }
        self = .object(try container.decode([String: JSONValue].self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

public enum RemoteMethod: String, Codable, Sendable {
    case capabilities, projectList = "project.list", sessionList = "session.list"
    case sessionGet = "session.get", sessionHistory = "session.history", sessionEvents = "session.events"
    case sessionPending = "session.pending", sessionDiff = "session.diff", selectionList = "selection.list"
    case operationGet = "operation.get", sessionCreate = "session.create", sessionPrompt = "session.prompt"
    case sessionInterrupt = "session.interrupt", sessionRename = "session.rename"
    case sessionSwitchAgent = "session.switchAgent", sessionSwitchModel = "session.switchModel"
    case permissionReply = "permission.reply", questionReply = "question.reply"
}

public struct ApprovedHost: Codable, Sendable, Equatable, Identifiable {
    public let id: UUID
    public let label: String
    public let hubURL: URL
    public let target: RemoteTarget
    public let publicKey: String
    public let grantID: String
    public let grantVersion: Int

    public init(id: UUID = UUID(), label: String, hubURL: URL, target: RemoteTarget,
                publicKey: String, grantID: String, grantVersion: Int) {
        self.id = id
        self.label = label
        self.hubURL = hubURL
        self.target = target
        self.publicKey = publicKey
        self.grantID = grantID
        self.grantVersion = grantVersion
    }
}

public enum RemoteRPCError: Error, Equatable {
    case invalidEndpoint, malformed, disconnected, timeout, cancelled, overloaded
    case rejected(String)
}

struct RemoteRequest: Encodable, Sendable {
    let version = 1
    let requestID: String
    let hostID: String
    let runtimeID: String
    let grantID: String
    let grantVersion: Int
    let method: RemoteMethod
    let sessionID: String?
    let projectID: String?
    let operationID: String?
    let payload: JSONValue
}

struct RemoteResponse: Decodable {
    let version: Int
    let type: String
    let requestID: String
    let data: JSONValue?
    let code: String?
    private enum CodingKeys: String, CodingKey { case version, type, requestID, data, code }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        type = try values.decode(String.self, forKey: .type)
        requestID = try values.decode(String.self, forKey: .requestID)
        data = values.contains(.data) ? try values.decode(JSONValue.self, forKey: .data) : nil
        code = try values.decodeIfPresent(String.self, forKey: .code)
    }
}

/// Only complete, ordered transfers are returned to the state reducer.
struct ResponseAssembler {
    private let allowedTypes: Set<String>
    private struct Chunk: Decodable {
        let version: Int
        let type: String
        let transferID: String
        let index: Int
        let total: Int
        let payload: String
    }
    private struct Header: Decodable { let version: Int; let type: String }
    private var transferID: String?
    private var total = 0
    private var next = 0
    private var bytes = Data()

    init(allowedTypes: Set<String> = ["result", "error"]) { self.allowedTypes = allowedTypes }

    mutating func append(_ packet: Data) throws -> Data? {
        guard packet.count <= 128 * 1024 else { throw RemoteRPCError.malformed }
        let header = try JSONDecoder().decode(Header.self, from: packet)
        guard header.version == 1 else { throw RemoteRPCError.malformed }
        if header.type != "chunk" {
            guard transferID == nil, allowedTypes.contains(header.type) else {
                throw RemoteRPCError.malformed
            }
            return packet
        }
        let chunk = try JSONDecoder().decode(Chunk.self, from: packet)
        guard UUID(uuidString: chunk.transferID) != nil, chunk.total > 0, chunk.total <= 128,
              chunk.index >= 0, chunk.index < chunk.total else { throw RemoteRPCError.malformed }
        if transferID == nil {
            guard chunk.index == 0 else { throw RemoteRPCError.malformed }
            transferID = chunk.transferID
            total = chunk.total
        }
        guard chunk.transferID == transferID, chunk.total == total, chunk.index == next,
              chunk.payload.utf8.count <= 88 * 1024 else { throw RemoteRPCError.malformed }
        let value = try decodeBase64URL(chunk.payload)
        guard value.count <= 64 * 1024, bytes.count + value.count <= 8 * 1024 * 1024 else {
            throw RemoteRPCError.malformed
        }
        bytes.append(value)
        next += 1
        guard next == total else { return nil }
        let result = bytes
        self = ResponseAssembler(allowedTypes: allowedTypes)
        return result
    }
}

func decodeBase64URL(_ value: String) throws -> Data {
    guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
        throw RemoteRPCError.malformed
    }
    let standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard let data = Data(base64Encoded: standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)),
          data.base64URL == value else { throw RemoteRPCError.malformed }
    return data
}
