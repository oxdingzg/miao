import Foundation
import CryptoKit
import MiaoCore

/// Test-only executable. All identities and grant scopes are supplied by the harness.
private struct Input: Decodable {
    let host: ApprovedHost
    let devicePrivateKey: String
}

@main
struct TransportProbe {
    static func main() async throws {
        let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
        let standard = input.devicePrivateKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let bytes = Data(base64Encoded: standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)) else {
            throw RemoteRPCError.malformed
        }
        let connection = try await HubConnection.open(host: input.host,
            identity: P256.Signing.PrivateKey(rawRepresentation: bytes), allowLoopbackHTTP: true) { connection in
            let directory = try await connection.request(.sessionGet, sessionID: "session-one")
            guard directory == .object(["title": .string("shared session")]) else { throw RemoteRPCError.malformed }
        }
        try await connection.synchronize()
        let large = try await connection.request(.sessionHistory, sessionID: "session-one")
        guard large == .object(["text": .string(String(repeating: "history ", count: 40_000))]) else {
            throw RemoteRPCError.malformed
        }
        let operation = UUID()
        let result = try await connection.request(.sessionPrompt, sessionID: "session-one", operationID: operation,
                                                  payload: .object(["text": .string("native prompt")]))
        guard result == .object(["accepted": .bool(true), "operationID": .string(operation.uuidString.lowercased())]) else {
            throw RemoteRPCError.malformed
        }
        do {
            try await connection.waitForDisconnect()
            throw RemoteRPCError.malformed
        } catch RemoteConnectionError.authorizationBlocked {}
        await connection.close()
        do {
            _ = try await connection.request(.sessionGet, sessionID: "session-one")
            throw RemoteRPCError.malformed
        } catch RemoteRPCError.disconnected {}
        print("{\"nativeTransport\":true,\"encryptedChunks\":true,\"stableOperationID\":true}")
    }
}
