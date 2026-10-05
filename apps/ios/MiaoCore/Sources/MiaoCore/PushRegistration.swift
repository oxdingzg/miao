import Foundation
import CryptoKit

public enum PushEnvironment: String, Codable, Sendable {
    case sandbox, production
}

/// A token is routing metadata, never a credential or a Runtime authorization.
public struct PushDeviceRegistration: Encodable, Sendable {
    public let deviceID: String
    public let token: String
    public let environment: PushEnvironment

    public init(deviceID: String, token: Data, environment: PushEnvironment) throws {
        guard let key = try? decodeBase64URL(deviceID), key.count == 65,
              key.base64URL == deviceID,
              (try? P256.Signing.PublicKey(x963Representation: key)) != nil,
              (16...256).contains(token.count) else { throw HubAccountError.malformed }
        self.deviceID = deviceID
        self.token = token.map { String(format: "%02x", $0) }.joined()
        self.environment = environment
    }
}

public struct HubPushRegistration: Decodable, Sendable {
    public let registeredAt: Int64
    public let registrationID: String
}
