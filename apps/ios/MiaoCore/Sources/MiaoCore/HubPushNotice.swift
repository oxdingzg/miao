import Foundation
import CryptoKit

public struct HubPushNotice: Decodable, Sendable {
    public let binding: PushContextBinding
    public let context: String
    private enum CodingKeys: String, CodingKey { case context, kind }
    public init(from decoder: Decoder) throws {
        binding = try PushContextBinding(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        context = try values.decode(String.self, forKey: .context)
        let kind = try values.decode(String.self, forKey: .kind)
        guard ["attention", "completed"].contains(kind), context.utf8.count <= 4096 else {
            throw HubAccountError.malformed
        }
    }

    public func resolve(device: P256.Signing.PrivateKey, host: AuthorizedHost) throws -> PushContextPayload {
        guard binding.hostID == host.host.target.hostID, binding.grantID == host.grant.id,
              binding.grantVersion == Int64(host.grant.version), binding.deviceID == host.grant.publicKey,
              !host.expired, host.grant.revokedAt == nil, host.grant.permissions.contains(.read) else {
            throw HubAccountError.authenticationRequired
        }
        let payload = try PushContext.open(context, device: device, pinnedHostKey: host.host.publicKey, binding: binding)
        guard host.grant.sessionIDs.contains(payload.sessionID) || host.grant.projectIDs.contains(payload.projectID) else {
            throw HubAccountError.authenticationRequired
        }
        return payload
    }
}
