import Foundation
import MiaoCore
import CryptoKit
#if os(iOS)
import SwiftUI
#endif

private enum AccountProbe {
    private struct Fixture: Decodable {
        let origin: URL; let email: String; let password: String
        let hostID: String; let hostName: String; let hostPublicKey: String
        let host: ApprovedHost; let devicePrivateKey: String
    }
    static func run(_ url: URL) async throws {
        print("NativeAccountStage:fixture")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let service = "miao.hub.probe." + UUID().uuidString
        let account = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        let restored = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        let cleared = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        do {
            print("NativeAccountStage:login")
            try await account.signIn(email: fixture.email, password: fixture.password)
            print("NativeAccountStage:directory")
            let before = try await account.bearer()
            let hosts = try await account.hosts()
            guard hosts.count == 1, hosts[0].hostID == fixture.hostID, hosts[0].name == fixture.hostName,
                  hosts[0].publicKey == fixture.hostPublicKey, hosts[0].online,
                  hosts[0].runtimeID == fixture.host.target.runtimeID, hosts[0].revokedAt == nil else { throw HubAccountError.malformed }
            print("NativeAccountStage:keychain")
            guard try await restored.restore() else { throw HubAccountError.authenticationRequired }
            _ = try await restored.bearer()
            let standard = fixture.devicePrivateKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            guard let bytes = Data(base64Encoded: standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)) else {
                throw HubAccountError.malformed
            }
            print("NativeAccountStage:pushRegistration")
            guard try await account.pushRegistrationAvailable() else { throw HubAccountError.malformed }
            let deviceID = try P256.Signing.PrivateKey(rawRepresentation: bytes).publicKey.x963Representation.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let push = try PushDeviceRegistration(deviceID: deviceID, token: Data(repeating: 0xab, count: 32), environment: .sandbox)
            let firstPush = try await account.registerPush(push)
            let replacementPush = try await account.registerPush(push)
            guard firstPush.registrationID != replacementPush.registrationID,
                  replacementPush.registeredAt > firstPush.registeredAt else { throw HubAccountError.malformed }
            try await account.revokePush(deviceID: deviceID)
            _ = try await account.registerPush(push)
            do {
                print("NativeAccountStage:denyDevice")
                let denied = try await HubConnection.open(host: fixture.host, identity: P256.Signing.PrivateKey(),
                    allowLoopbackHTTP: true, account: account) { _ in }
                await denied.close()
                throw HubAccountError.malformed
            } catch RemoteConnectionError.authorizationBlocked {}
            // A saved Runtime instance is stale after a computer restart; only the directory may refresh it.
            let previousHost = ApprovedHost(id: fixture.host.id, label: fixture.host.label, hubURL: fixture.host.hubURL,
                target: RemoteTarget(hostID: fixture.host.target.hostID, runtimeID: UUID().uuidString),
                publicKey: fixture.host.publicKey, grantID: fixture.host.grantID, grantVersion: fixture.host.grantVersion)
            print("NativeAccountStage:refreshRuntime")
            let connection = try await HubConnection.open(host: previousHost,
                identity: P256.Signing.PrivateKey(rawRepresentation: bytes), allowLoopbackHTTP: true, account: account) { connection in
                let result = try await connection.request(.sessionGet, sessionID: "session-one")
                guard result == .object(["title": .string("Account relay session")]) else { throw RemoteRPCError.malformed }
            }
            print("NativeAccountStage:rpc")
            do { try await connection.synchronize() }
            catch { await connection.close(); throw error }
            print("NativeAccountStage:secondConnection")
            let remoteConnection = try await HubConnection.open(host: fixture.host,
                identity: P256.Signing.PrivateKey(rawRepresentation: bytes), allowLoopbackHTTP: true, account: restored) { _ in }
            print("NativeAccountStage:logout")
            try await account.signOut()
            do {
                _ = try await account.registerPush(push)
                throw HubAccountError.malformed
            } catch HubAccountError.authenticationRequired {}
            do {
                _ = try await restored.hosts()
                throw HubAccountError.malformed
            } catch HubAccountError.authenticationRequired {}
            print("NativeAccountStage:disconnect")
            do { try await connection.waitForDisconnect(); throw HubAccountError.malformed }
            catch RemoteConnectionError.authorizationBlocked {}
            await connection.close()
            do { try await remoteConnection.waitForDisconnect(); throw HubAccountError.malformed }
            catch RemoteConnectionError.authorizationBlocked {}
            await remoteConnection.close()
            print("NativeAccountStage:cleared")
            guard try await !cleared.restore(), !before.isEmpty else { throw HubAccountError.malformed }
        } catch {
            try? await account.signOut()
            await account.close(); await restored.close(); await cleared.close()
            throw error
        }
        await account.close(); await restored.close(); await cleared.close()
        print("{\"nativeAccount\":true}")
    }
}

#if os(iOS)
@main struct HubAccountProbe: App {
    var body: some Scene {
        WindowGroup {
            Text("Native account integration").task {
                do {
                    guard let fixture = Bundle.main.url(forResource: "fixture", withExtension: "json") else {
                        throw HubAccountError.malformed
                    }
                    try await AccountProbe.run(fixture)
                    exit(0)
                } catch { print("Native account integration failed"); exit(1) }
            }
        }
    }
}
#else
@main struct HubAccountProbe {
    static func main() async throws {
        try await AccountProbe.run(URL(fileURLWithPath: CommandLine.arguments[1]))
    }
}
#endif
