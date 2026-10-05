// Test-only peer for checking the TypeScript/CryptoKit wire contract.
// It deliberately trusts the test input key and must never be used as an Agent.
import Foundation
import CryptoKit
import MiaoCore

func output<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data + Data([10]))
}
struct IdentityReply: Codable { let signingKey: String }
struct CipherReply: Codable { let packet: String; let plaintext: String }
func base64URL(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

let identity = P256.Signing.PrivateKey()
try output(IdentityReply(signingKey: base64URL(identity.publicKey.x963Representation)))
guard let line = readLine(), let data = line.data(using: .utf8) else { throw ChannelError.malformed }
let client = try JSONDecoder().decode(ClientHello.self, from: data)
let accepted = try HostHandshake.accept(
    identity: identity, target: RemoteTarget(hostID: client.hostID, runtimeID: client.runtimeID),
    connectionID: "interop-connection-000000", client: client, trustedDeviceKey: client.signingKey)
try output(accepted.hello)
guard let packet = readLine() else { throw ChannelError.malformed }
let plaintext = try await accepted.session.open(packet)
let reply = try await accepted.session.seal(Data("Swift result".utf8))
try output(CipherReply(packet: reply, plaintext: String(decoding: plaintext, as: UTF8.self)))

struct PushInterop: Decodable { let binding: PushContextBinding; let pinnedHostKey: String; let context: String }
guard let pushLine = readLine(), let pushData = pushLine.data(using: .utf8) else { throw ChannelError.malformed }
let push = try JSONDecoder().decode(PushInterop.self, from: pushData)
let openedPush = try PushContext.open(push.context, device: identity, pinnedHostKey: push.pinnedHostKey, binding: push.binding)
do {
    _ = try PushContext.open(push.context, device: identity, pinnedHostKey: base64URL(identity.publicKey.x963Representation), binding: push.binding)
    throw ChannelError.malformed
} catch ChannelError.invalidSignature {}
let wrongSignal = PushContextBinding(hostID: push.binding.hostID, runtimeID: push.binding.runtimeID,
    grantID: push.binding.grantID, grantVersion: push.binding.grantVersion, deviceID: push.binding.deviceID, signalID: UUID().uuidString)
do {
    _ = try PushContext.open(push.context, device: identity, pinnedHostKey: push.pinnedHostKey, binding: wrongSignal)
    throw ChannelError.malformed
} catch ChannelError.invalidSignature {}
try output(openedPush)
