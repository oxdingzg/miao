import Foundation
import CryptoKit
import MiaoCore

private struct Input: Decodable {
    let uri: String
    let devicePrivateKey: String
    let failSave: Bool
    let expectedSessionCount: Int
}

private actor Receipt {
    var grant: DeviceGrant?
    var fingerprint: String?
    func save(_ grant: DeviceGrant) { self.grant = grant }
    func received(_ fingerprint: String) { self.fingerprint = fingerprint }
}

@main
struct PairingProbe {
    static func main() async throws {
        let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
        let raw = input.devicePrivateKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let bytes = Data(base64Encoded: raw + String(repeating: "=", count: (4 - raw.count % 4) % 4)) else {
            throw RemoteRPCError.malformed
        }
        let identity = try P256.Signing.PrivateKey(rawRepresentation: bytes)
        let receipt = Receipt()
        do {
            let paired = try await HubConnection.pair(
                invitation: PairingInvitation.parse(input.uri, allowLoopbackHTTP: true),
                identity: identity, label: "原生手机 / 🎤", allowLoopbackHTTP: true,
                pending: { fingerprint in
                    await receipt.received(fingerprint)
                },
                persist: { _, grant in
                    if input.failSave { throw ClientStateError.invalidStorage }
                    await receipt.save(grant)
                },
                reconcile: { connection in
                    guard await receipt.grant != nil else { throw ClientStateError.invalidStorage }
                    guard try await connection.request(.sessionGet, sessionID: "session-one") ==
                            .object(["title": .string("paired session")]) else { throw RemoteRPCError.malformed }
                }
            )
            guard !input.failSave, await receipt.grant == paired.grant,
                  await receipt.fingerprint == DeviceFingerprint.of(identity.publicKey),
                  paired.grant.permissions == [.read], paired.grant.sessionIDs.first == "session-one",
                  paired.grant.sessionIDs.count == input.expectedSessionCount else {
                throw RemoteRPCError.malformed
            }
            try await paired.connection.synchronize()
            await paired.connection.close()
            print("{\"nativePairing\":true}")
        } catch PairingError.approvalUncertain {
            guard input.failSave else { throw PairingError.approvalUncertain }
            print("{\"saveFailed\":true}")
        }
    }
}
