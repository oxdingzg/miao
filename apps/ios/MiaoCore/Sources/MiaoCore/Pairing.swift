import Foundation
import CryptoKit

public enum PairingError: Error, Equatable {
    case invalidInvitation, expired, invalidLabel, invalidGrant, approvalUncertain
}

public enum RemotePermission: String, Codable, Sendable {
    case read, prompt, permissionReply = "permission.reply", questionReply = "question.reply"
    case interrupt, sessionCreate = "session.create", sessionRename = "session.rename"
}

public struct DeviceGrant: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let version: Int
    public let publicKey: String
    public let label: String
    public let permissions: [RemotePermission]
    public let projectIDs: [String]
    public let sessionIDs: [String]
    public let createdAt: Int64
    public let expiresAt: Int64
    public let revokedAt: Int64?

    func validate(deviceKey: String, now: Date = Date()) throws {
        guard id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
              version > 0, publicKey == deviceKey, revokedAt == nil,
              expiresAt > Int64(now.timeIntervalSince1970 * 1000),
              !label.isEmpty, label.utf16.count <= 128,
              !permissions.isEmpty, permissions.count <= 16,
              projectIDs.count <= 128, sessionIDs.count <= 256,
              !projectIDs.isEmpty || !sessionIDs.isEmpty,
              (projectIDs + sessionIDs).allSatisfy({ !$0.isEmpty && $0.utf16.count <= 128 }) else {
            throw PairingError.invalidGrant
        }
    }
}

public struct PairingInvitation: Codable, Sendable, Equatable {
    public let version: Int
    public let pairingID: String
    public let secret: String
    public let hubURL: String
    public let hostID: String
    public let runtimeID: String
    public let hostPublicKey: String
    public let expiresAt: Int64

    public var target: RemoteTarget { RemoteTarget(hostID: hostID, runtimeID: runtimeID) }

    /// Only explicit scans/pastes call this parser. The secret never goes into a query or a log.
    public static func parse(_ uri: String, now: Date = Date(), allowLoopbackHTTP: Bool = false) throws -> PairingInvitation {
        guard uri.utf8.count <= 8192, let url = URLComponents(string: uri),
              url.scheme == "miao", url.host == "pair", url.path.isEmpty,
              url.user == nil, url.password == nil, url.port == nil, url.query == nil,
              let fragment = url.fragment, fragment.utf8.count <= 6144 else { throw PairingError.invalidInvitation }
        do {
            let invitation = try JSONDecoder().decode(PairingInvitation.self, from: decodeBase64URL(fragment))
            try invitation.validate(now: now, allowLoopbackHTTP: allowLoopbackHTTP)
            return invitation
        } catch let error as PairingError { throw error }
        catch { throw PairingError.invalidInvitation }
    }

    func validate(now: Date = Date(), allowLoopbackHTTP: Bool = false) throws {
        guard version == 1,
              pairingID.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
              secret.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw PairingError.invalidInvitation
        }
        guard expiresAt > Int64(now.timeIntervalSince1970 * 1000) else { throw PairingError.expired }
        do {
            try target.validate()
            _ = try P256.Signing.PublicKey(x963Representation: decodeBase64URL(hostPublicKey))
            _ = try HubConnection.endpoint(hubURL: URL(string: hubURL), hostID: hostID, allowLoopbackHTTP: allowLoopbackHTTP)
        } catch { throw PairingError.invalidInvitation }
    }

    func claim(label: String, hello: ClientHello) throws -> Data {
        guard !label.isEmpty, label.utf16.count <= 128 else { throw PairingError.invalidLabel }
        guard secret.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw PairingError.invalidInvitation }
        let bytes = stride(from: 0, to: secret.count, by: 2).map { offset -> UInt8 in
            let start = secret.index(secret.startIndex, offsetBy: offset)
            return UInt8(secret[start..<secret.index(start, offsetBy: 2)], radix: 16)!
        }
        let transcript = try canonical(["miao.control.pair.v1", pairingID, label, hello.object])
        let proof = HMAC<SHA256>.authenticationCode(for: transcript, using: SymmetricKey(data: bytes))
            .map { String(format: "%02x", $0) }.joined()
        return try JSONEncoder().encode(Claim(pairingID: pairingID, label: label, hello: hello, proof: proof))
    }

    private struct Claim: Encodable {
        let pairingID: String
        let label: String
        let hello: ClientHello
        let proof: String
    }
}

public struct PairedConnection: Sendable {
    public let host: ApprovedHost
    public let grant: DeviceGrant
    public let connection: HubConnection
}

struct PairingNotification: Decodable {
    let version: Int
    let type: String
    let status: String
    let pairingID: String?
    let grant: DeviceGrant?
}

public enum DeviceFingerprint {
    public static func of(_ key: P256.Signing.PublicKey) -> String {
        Data(SHA256.hash(data: key.x963Representation)).base64URL
    }
}
