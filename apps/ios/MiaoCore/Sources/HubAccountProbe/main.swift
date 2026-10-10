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
        let grant: DeviceGrant; let notificationURL: URL; let notificationToken: String
    }
    private struct Receipt: Codable {
        let stage: String
        let finished: Bool
        let nativeAccount: Bool
    }
    private static func receiptURL() throws -> URL {
        try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appendingPathComponent("native-account-result.json")
    }
    private static func stage(_ name: String) throws {
        print("NativeAccountStage:\(name)")
        #if os(iOS)
        let receipt = Receipt(stage: name, finished: false, nativeAccount: false)
        try JSONEncoder().encode(receipt).write(to: receiptURL(), options: .atomic)
        #endif
    }
    static func finish(success: Bool) throws {
        #if os(iOS)
        let url = try receiptURL()
        let previous = try? JSONDecoder().decode(Receipt.self, from: Data(contentsOf: url))
        let receipt = Receipt(stage: previous?.stage ?? "notStarted", finished: true, nativeAccount: success)
        try JSONEncoder().encode(receipt).write(to: url, options: .atomic)
        #endif
    }
    static func run(_ url: URL) async throws {
        try stage("fixture")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let service = "miao.hub.probe." + UUID().uuidString
        let account = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        let restored = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        let cleared = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        do {
            try stage("login")
            try await account.signIn(email: fixture.email, password: fixture.password)
            try stage("directory")
            let before = try await account.bearer()
            let hosts = try await account.hosts()
            guard hosts.count == 1, hosts[0].hostID == fixture.hostID, hosts[0].name == fixture.hostName,
                  hosts[0].publicKey == fixture.hostPublicKey, hosts[0].online,
                  hosts[0].runtimeID == fixture.host.target.runtimeID, hosts[0].revokedAt == nil else { throw HubAccountError.malformed }
            try stage("keychain")
            guard try await restored.restore() else { throw HubAccountError.authenticationRequired }
            _ = try await restored.bearer()
            let standard = fixture.devicePrivateKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            guard let bytes = Data(base64Encoded: standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)) else {
                throw HubAccountError.malformed
            }
            try stage("pushRegistration")
            guard try await account.pushRegistrationAvailable(requireDelivery: true) else { throw HubAccountError.malformed }
            let deviceID = try P256.Signing.PrivateKey(rawRepresentation: bytes).publicKey.x963Representation.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let push = try PushDeviceRegistration(deviceID: deviceID, token: Data(repeating: 0xab, count: 32), environment: .sandbox)
            let firstPush = try await account.registerPush(push)
            let replacementPush = try await account.registerPush(push)
            guard firstPush.registrationID != replacementPush.registrationID,
                  replacementPush.registeredAt > firstPush.registeredAt else { throw HubAccountError.malformed }
            try await account.revokePush(deviceID: deviceID)
            _ = try await account.registerPush(push)
            try stage("pushContext")
            func notification(_ route: String) async throws -> String {
                var request = URLRequest(url: fixture.notificationURL.appendingPathComponent(route))
                request.httpMethod = "POST"
                request.setValue("Bearer " + fixture.notificationToken, forHTTPHeaderField: "Authorization")
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count <= 1024 else {
                    throw HubAccountError.malformed
                }
                struct Emitted: Decodable { let signalID: String }
                return try JSONDecoder().decode(Emitted.self, from: data).signalID
            }
            let signalID = try await notification("emit")
            let notice = try await account.pushContext(deviceID: deviceID, signalID: signalID)
            let payload = try notice.resolve(device: P256.Signing.PrivateKey(rawRepresentation: bytes),
                host: AuthorizedHost(host: fixture.host, grant: fixture.grant))
            guard payload.sessionID == "session-one", payload.projectID == "project-one" else { throw HubAccountError.malformed }
            _ = try await account.registerPush(push)
            _ = try await account.pushContext(deviceID: deviceID, signalID: signalID)
            let otherDevice = P256.Signing.PrivateKey().publicKey.x963Representation.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            do {
                _ = try await account.pushContext(deviceID: otherDevice, signalID: signalID)
                throw HubAccountError.malformed
            } catch HubAccountError.rejected(404) {}
            do {
                try stage("denyDevice")
                let denied = try await HubConnection.open(host: fixture.host, identity: P256.Signing.PrivateKey(),
                    allowLoopbackHTTP: true, account: account) { _ in }
                await denied.close()
                throw HubAccountError.malformed
            } catch RemoteConnectionError.authorizationBlocked {}
            // A stale window must never silently reconnect to another window.
            let previousHost = ApprovedHost(id: fixture.host.id, label: fixture.host.label, hubURL: fixture.host.hubURL,
                target: RemoteTarget(hostID: fixture.host.target.hostID, runtimeID: UUID().uuidString),
                publicKey: fixture.host.publicKey, grantID: fixture.host.grantID, grantVersion: fixture.host.grantVersion)
            try stage("refreshRuntime")
            do {
                let stale = try await HubConnection.open(host: previousHost,
                    identity: P256.Signing.PrivateKey(rawRepresentation: bytes), allowLoopbackHTTP: true, account: account) { _ in }
                await stale.close()
                throw HubAccountError.malformed
            } catch RemoteConnectionError.authorizationBlocked {}
            let connection = try await HubConnection.open(host: fixture.host,
                identity: P256.Signing.PrivateKey(rawRepresentation: bytes), allowLoopbackHTTP: true, account: account) { connection in
                let result = try await connection.request(.sessionGet, sessionID: "session-one")
                guard result == .object(["title": .string("Account relay session")]) else { throw RemoteRPCError.malformed }
            }
            try stage("rpc")
            do { try await connection.synchronize() }
            catch { await connection.close(); throw error }
            try stage("secondConnection")
            let remoteConnection = try await HubConnection.open(host: fixture.host,
                identity: P256.Signing.PrivateKey(rawRepresentation: bytes), allowLoopbackHTTP: true, account: restored) { _ in }
            try stage("pushRevocation")
            _ = try await notification("revoke")
            do {
                _ = try await account.pushContext(deviceID: deviceID, signalID: signalID)
                throw HubAccountError.malformed
            } catch HubAccountError.rejected(404) {}
            try stage("logout")
            try await account.signOut()
            do {
                _ = try await account.registerPush(push)
                throw HubAccountError.malformed
            } catch HubAccountError.authenticationRequired {}
            do {
                _ = try await restored.hosts()
                throw HubAccountError.malformed
            } catch HubAccountError.authenticationRequired {}
            try stage("disconnect")
            do { try await connection.waitForDisconnect(); throw HubAccountError.malformed }
            catch RemoteConnectionError.authorizationBlocked {}
            await connection.close()
            do { try await remoteConnection.waitForDisconnect(); throw HubAccountError.malformed }
            catch RemoteConnectionError.authorizationBlocked {}
            await remoteConnection.close()
            try stage("cleared")
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
                    try AccountProbe.finish(success: true)
                    exit(0)
                } catch {
                    try? AccountProbe.finish(success: false)
                    print("Native account integration failed")
                    exit(1)
                }
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
