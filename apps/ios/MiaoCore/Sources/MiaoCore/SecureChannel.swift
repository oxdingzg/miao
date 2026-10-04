import Foundation
import CryptoKit

public enum ChannelError: Error, Equatable {
    case malformed, untrustedIdentity, challengeMismatch, invalidSignature
    case handshakeUsed, replay, exhausted, frameTooLarge
}

public struct RemoteTarget: Codable, Sendable, Equatable {
    public let hostID: String
    public let runtimeID: String
    public init(hostID: String, runtimeID: String) {
        self.hostID = hostID
        self.runtimeID = runtimeID
    }
    func validate() throws {
        try validateIdentifier(hostID)
        try validateIdentifier(runtimeID)
    }
}

public struct ClientHello: Codable, Sendable {
    public let version: Int
    public let hostID: String
    public let runtimeID: String
    public let signingKey: String
    public let agreementKey: String
    public let challenge: String
    public let signature: String
    var payload: [String: Any] {
        ["version": version, "hostID": hostID, "runtimeID": runtimeID,
         "signingKey": signingKey, "agreementKey": agreementKey, "challenge": challenge]
    }
    var object: [String: Any] { payload.merging(["signature": signature]) { _, new in new } }
}

public struct ServerHello: Codable, Sendable {
    public let version: Int
    public let hostID: String
    public let runtimeID: String
    public let connectionID: String
    public let signingKey: String
    public let agreementKey: String
    public let challenge: String
    public let clientChallenge: String
    public let signature: String
    var payload: [String: Any] {
        ["version": version, "hostID": hostID, "runtimeID": runtimeID,
         "connectionID": connectionID, "signingKey": signingKey,
         "agreementKey": agreementKey, "challenge": challenge, "clientChallenge": clientChallenge]
    }
    var object: [String: Any] { payload.merging(["signature": signature]) { _, new in new } }
}

/// The trust anchor must come from local pairing, never from relay metadata.
public actor ClientHandshake {
    public let hello: ClientHello
    private let target: RemoteTarget
    private let agreement: P256.KeyAgreement.PrivateKey
    private var finished = false

    public init(identity: P256.Signing.PrivateKey, target: RemoteTarget) throws {
        try target.validate()
        self.target = target
        agreement = P256.KeyAgreement.PrivateKey()
        let signingKey = identity.publicKey.x963Representation.base64URL
        let agreementKey = agreement.publicKey.x963Representation.base64URL
        let challenge = randomChallenge()
        let payload: [String: Any] = [
            "version": 1, "hostID": target.hostID, "runtimeID": target.runtimeID,
            "signingKey": signingKey, "agreementKey": agreementKey, "challenge": challenge
        ]
        let signature = try identity.signature(for: canonical(["miao.control.client.v1", payload]))
        hello = ClientHello(version: 1, hostID: target.hostID, runtimeID: target.runtimeID,
                            signingKey: signingKey,
                            agreementKey: agreementKey,
                            challenge: challenge,
                            signature: signature.rawRepresentation.base64URL)
    }

    public func finish(_ peer: ServerHello, trustedHostKey: String) throws -> SecureSession {
        guard !finished else { throw ChannelError.handshakeUsed }
        finished = true
        try validateIdentifier(peer.connectionID)
        guard peer.version == 1, peer.hostID == target.hostID, peer.runtimeID == target.runtimeID,
              peer.signingKey == trustedHostKey else { throw ChannelError.untrustedIdentity }
        guard peer.clientChallenge == hello.challenge else { throw ChannelError.challengeMismatch }
        _ = try binary(peer.challenge, length: 32)
        try verify(key: trustedHostKey, signature: peer.signature,
                   transcript: ["miao.control.server.v1", hello.object, peer.payload])
        return try makeSession(agreement: agreement, peerKey: peer.agreementKey,
                               client: hello, host: peer, isClient: true)
    }
}

/// Authorization of the device key must precede acceptance; there is no auto-trust.
public enum HostHandshake {
    public static func accept(identity: P256.Signing.PrivateKey, target: RemoteTarget,
                              connectionID: String, client: ClientHello, trustedDeviceKey: String)
    throws -> (hello: ServerHello, session: SecureSession) {
        try target.validate()
        try validateIdentifier(connectionID)
        guard client.version == 1, client.hostID == target.hostID, client.runtimeID == target.runtimeID,
              client.signingKey == trustedDeviceKey else { throw ChannelError.untrustedIdentity }
        _ = try binary(client.challenge, length: 32)
        try verify(key: trustedDeviceKey, signature: client.signature,
                   transcript: ["miao.control.client.v1", client.payload])
        let agreement = P256.KeyAgreement.PrivateKey()
        let challenge = randomChallenge()
        let signingKey = identity.publicKey.x963Representation.base64URL
        let agreementKey = agreement.publicKey.x963Representation.base64URL
        let payload: [String: Any] = [
            "version": 1, "hostID": target.hostID, "runtimeID": target.runtimeID,
            "connectionID": connectionID, "signingKey": signingKey,
            "agreementKey": agreementKey,
            "challenge": challenge, "clientChallenge": client.challenge
        ]
        let signature = try identity.signature(for: canonical(["miao.control.server.v1", client.object, payload]))
        let hello = ServerHello(version: 1, hostID: target.hostID, runtimeID: target.runtimeID,
                                connectionID: connectionID, signingKey: signingKey,
                                agreementKey: agreementKey,
                                challenge: challenge, clientChallenge: client.challenge,
                                signature: signature.rawRepresentation.base64URL)
        return (hello, try makeSession(agreement: agreement, peerKey: client.agreementKey,
                                       client: client, host: hello, isClient: false))
    }
}

/// Actor isolation makes sequence checks and authenticated cursor advancement atomic.
public actor SecureSession {
    private let sendKey: SymmetricKey
    private let receiveKey: SymmetricKey
    private var sent: UInt64 = 0
    private var received: UInt64 = 0
    private let maximumSequence: UInt64 = 9_007_199_254_740_991

    init(sendKey: SymmetricKey, receiveKey: SymmetricKey) {
        self.sendKey = sendKey
        self.receiveKey = receiveKey
    }

    public func seal(_ plaintext: Data) throws -> String {
        guard plaintext.count <= 128 * 1024 else { throw ChannelError.frameTooLarge }
        guard sent < maximumSequence else { throw ChannelError.exhausted }
        sent += 1
        let header = Data([1]) + withUnsafeBytes(of: sent.bigEndian) { Data($0) }
        let nonce = try AES.GCM.Nonce(data: Data(repeating: 0, count: 4) + header.dropFirst())
        let box = try AES.GCM.seal(plaintext, using: sendKey, nonce: nonce, authenticating: header)
        return (header + box.ciphertext + box.tag).base64URL
    }

    public func open(_ encoded: String) throws -> Data {
        guard encoded.utf8.count <= 180 * 1024 else { throw ChannelError.frameTooLarge }
        let packet = try binary(encoded)
        guard packet.count >= 25, packet.first == 1 else { throw ChannelError.malformed }
        let header = Data(packet.prefix(9))
        let sequence = header.dropFirst().reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard sequence == received + 1 else { throw ChannelError.replay }
        let nonce = try AES.GCM.Nonce(data: Data(repeating: 0, count: 4) + header.dropFirst())
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: packet.dropFirst(9).dropLast(16), tag: packet.suffix(16))
        let plaintext = try AES.GCM.open(box, using: receiveKey, authenticating: header)
        received += 1
        return plaintext
    }
}

private func makeSession(agreement: P256.KeyAgreement.PrivateKey, peerKey: String,
                         client: ClientHello, host: ServerHello, isClient: Bool) throws -> SecureSession {
    let peer = try P256.KeyAgreement.PublicKey(x963Representation: binary(peerKey, length: 65))
    let secret = try agreement.sharedSecretFromKeyAgreement(with: peer)
    let salt = Data(SHA256.hash(data: try canonical([client.object, host.object])))
    func derive(_ direction: String) throws -> SymmetricKey {
        secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
                                      sharedInfo: try canonical(["miao.control.channel.v1", direction]), outputByteCount: 32)
    }
    let clientKey = try derive("client-to-host")
    let hostKey = try derive("host-to-client")
    return SecureSession(sendKey: isClient ? clientKey : hostKey, receiveKey: isClient ? hostKey : clientKey)
}

private func verify(key: String, signature: String, transcript: [Any]) throws {
    let publicKey = try P256.Signing.PublicKey(x963Representation: binary(key, length: 65))
    let signature = try P256.Signing.ECDSASignature(rawRepresentation: binary(signature, length: 64))
    guard publicKey.isValidSignature(signature, for: try canonical(transcript)) else { throw ChannelError.invalidSignature }
}

func canonical(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
}

private func validateIdentifier(_ value: String) throws {
    guard value.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil else { throw ChannelError.malformed }
}

private func randomChallenge() -> String {
    SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64URL }
}

private func binary(_ value: String, length: Int? = nil) throws -> Data {
    guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw ChannelError.malformed }
    let standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padded = standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)
    guard let data = Data(base64Encoded: padded), data.base64URL == value,
          length == nil || data.count == length else { throw ChannelError.malformed }
    return data
}

extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
