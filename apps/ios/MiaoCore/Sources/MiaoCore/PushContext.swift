import Foundation
import CryptoKit

public struct PushContextBinding: Codable, Sendable {
    public let hostID: String
    public let runtimeID: String
    public let grantID: String
    public let grantVersion: Int64
    public let deviceID: String
    public let signalID: String
    public init(hostID: String, runtimeID: String, grantID: String, grantVersion: Int64, deviceID: String, signalID: String) {
        self.hostID = hostID; self.runtimeID = runtimeID; self.grantID = grantID
        self.grantVersion = grantVersion; self.deviceID = deviceID; self.signalID = signalID
    }
}
public struct PushContextPayload: Codable, Sendable, Equatable {
    public let sessionID: String
    public let projectID: String
    public let expiresAt: Int64
}

public enum PushContext {
    /// Verify the locally pinned host before decrypting. This hint grants no session authority.
    public static func open(_ encoded: String, device: P256.Signing.PrivateKey,
                            pinnedHostKey: String, binding: PushContextBinding) throws -> PushContextPayload {
        guard encoded.utf8.count <= 4096, let packet = try? decodeBase64URL(encoded), packet.count >= 158,
              packet.count <= 3072, packet.first == 1,
              device.publicKey.x963Representation.base64URL == binding.deviceID,
              (1...9_007_199_254_740_991).contains(binding.grantVersion) else { throw ChannelError.malformed }
        for id in [binding.hostID, binding.runtimeID, binding.grantID, binding.signalID] {
            guard id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil else { throw ChannelError.malformed }
        }
        let associated = try JSONSerialization.data(withJSONObject: [binding.hostID, binding.runtimeID, binding.grantID,
            binding.grantVersion, binding.deviceID, binding.signalID], options: [.withoutEscapingSlashes])
        let domain = Data("miao.push.context.v1\0".utf8)
        let body = Data(packet.dropLast(64))
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: packet.suffix(64))
        let host = try P256.Signing.PublicKey(x963Representation: decodeBase64URL(pinnedHostKey))
        guard host.isValidSignature(signature, for: domain + associated + body) else { throw ChannelError.invalidSignature }
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: body.subdata(in: 1..<66))
        let agreement = try P256.KeyAgreement.PrivateKey(rawRepresentation: device.rawRepresentation)
        let secret = try agreement.sharedSecretFromKeyAgreement(with: peer)
        let key = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(SHA256.hash(data: associated)), sharedInfo: domain, outputByteCount: 32)
        let nonce = try AES.GCM.Nonce(data: body.subdata(in: 66..<78))
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: body.dropFirst(78).dropLast(16), tag: body.suffix(16))
        let plaintext = try AES.GCM.open(box, using: key, authenticating: domain + associated + body.prefix(78))
        let payload = try JSONDecoder().decode(PushContextPayload.self, from: plaintext)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard payload.expiresAt > now, payload.expiresAt <= now + 600_000 else { throw ChannelError.malformed }
        for id in [payload.sessionID, payload.projectID] {
            guard id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { throw ChannelError.malformed }
        }
        return payload
    }
}
