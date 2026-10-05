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
var noticeFields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(push.binding)) as! [String: Any]
noticeFields["context"] = push.context
noticeFields["kind"] = "attention"
let notice = try JSONDecoder().decode(HubPushNotice.self, from: JSONSerialization.data(withJSONObject: noticeFields))
let grantFields: [String: Any] = ["id": push.binding.grantID, "version": push.binding.grantVersion,
    "publicKey": push.binding.deviceID, "label": "Phone", "permissions": ["read"],
    "projectIDs": [openedPush.projectID], "sessionIDs": [], "createdAt": 0,
    "expiresAt": openedPush.expiresAt, "revokedAt": NSNull()]
func authorized(_ changes: [String: Any] = [:]) throws -> AuthorizedHost {
    let grant = try JSONDecoder().decode(DeviceGrant.self,
        from: JSONSerialization.data(withJSONObject: grantFields.merging(changes) { _, new in new }))
    let host = ApprovedHost(label: "Computer", hubURL: URL(string: "https://relay.example.invalid")!,
        target: RemoteTarget(hostID: push.binding.hostID, runtimeID: push.binding.runtimeID),
        publicKey: push.pinnedHostKey, grantID: push.binding.grantID, grantVersion: Int(push.binding.grantVersion))
    return AuthorizedHost(host: host, grant: grant)
}
guard try notice.resolve(device: identity, host: authorized()) == openedPush else { throw ChannelError.malformed }
for change: [String: Any] in [
    ["version": push.binding.grantVersion + 1], ["permissions": ["prompt"]],
    ["projectIDs": ["other-project"]], ["expiresAt": 0], ["revokedAt": 1],
] {
    do {
        _ = try notice.resolve(device: identity, host: authorized(change))
        throw ChannelError.malformed
    } catch HubAccountError.authenticationRequired {}
}
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
