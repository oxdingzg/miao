import Foundation
import MiaoCore
#if os(iOS)
import SwiftUI
#endif

private enum AccountProbe {
    private struct Fixture: Decodable {
        let origin: URL; let email: String; let password: String
        let hostID: String; let hostName: String; let hostPublicKey: String
    }
    static func run(_ url: URL) async throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let service = "miao.hub.probe." + UUID().uuidString
        let account = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        let restored = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        let cleared = try HubAccount(origin: fixture.origin, keychainService: service, allowLoopbackHTTP: true)
        do {
            try await account.signIn(email: fixture.email, password: fixture.password)
            let before = try await account.bearer()
            let hosts = try await account.hosts()
            guard hosts.count == 1, hosts[0].hostID == fixture.hostID, hosts[0].name == fixture.hostName,
                  hosts[0].publicKey == fixture.hostPublicKey, !hosts[0].online,
                  hosts[0].runtimeID == nil, hosts[0].revokedAt == nil else { throw HubAccountError.malformed }
            guard try await restored.restore() else { throw HubAccountError.authenticationRequired }
            _ = try await restored.bearer()
            try await account.signOut()
            do {
                _ = try await restored.hosts()
                throw HubAccountError.malformed
            } catch HubAccountError.authenticationRequired {}
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
