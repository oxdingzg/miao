import Foundation
import CryptoKit
import MiaoCore

@main struct RosterAdmissionProbe {
    private struct Fixture: Decodable {
        let origin: URL; let email: String; let password: String
        let approveURL: URL; let fixtureToken: String; let rootKey: String
    }
    static func stage(_ value: String) { FileHandle.standardOutput.write(Data(("NATIVE_ROSTER_STAGE: " + value + "\n").utf8)) }
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { throw HubAccountError.malformed }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let keychainService = "miao.roster.probe." + UUID().uuidString
        let account = try HubAccount(origin: fixture.origin, keychainService: keychainService, allowLoopbackHTTP: true)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            stage("login")
            try await account.signIn(email: fixture.email, password: fixture.password)
            stage("authenticated-profile")
            let accountID = try await account.authenticatedAccountID()
            // Foreground directory refresh must not exhaust the Hub's auth rate
            // limit by repeatedly looking up the same authenticated identity.
            for _ in 0..<40 {
                guard try await account.authenticatedAccountID() == accountID else { throw HubAccountError.malformed }
            }
            let key = P256.Signing.PrivateKey()
            stage("account-access-without-enrollment")
            guard let directTarget = try await account.hosts().first(where: { $0.online }) else { throw HubAccountError.malformed }
            let directRegistry = try HostRegistry(directory: directory.appendingPathComponent("signed-in"),
                deviceKey: key.publicKey.x963Representation.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""), allowLoopbackHTTP: true)
            let directID = UUID()
            for _ in 0..<2 {
                let direct = try await HubConnection.autoAdmit(account: account, discovered: directTarget, identity: key,
                    accountAccess: true, existingID: directID,
                    persist: { host, grant in try await directRegistry.admitSignedIn(host: host, grant: grant, accountID: accountID) },
                    reconcile: { _ in })
                let value = try await direct.connection.request(.sessionGet, sessionID: "session-one")
                guard value["title"]?.string == "Native admitted session" else { throw HubAccountError.malformed }
                await direct.connection.close()
            }
            let directHosts = try await directRegistry.hosts()
            guard directHosts.count == 1, directHosts[0].id == directID else { throw HubAccountError.malformed }
            stage("account-keychain-cold-restore")
            let restoredAccount = try HubAccount(origin: fixture.origin, keychainService: keychainService, allowLoopbackHTTP: true)
            guard try await restoredAccount.restore(), try await restoredAccount.authenticatedAccountID() == accountID else { throw HubAccountError.malformed }
            let cold = try await HubConnection.autoAdmit(account: restoredAccount, discovered: directTarget, identity: key,
                accountAccess: true, existingID: directID, persist: { _, _ in }, reconcile: { _ in })
            let coldValue = try await cold.connection.request(.sessionGet, sessionID: "session-one")
            guard coldValue["title"]?.string == "Native admitted session" else { throw HubAccountError.malformed }
            await cold.connection.close()
            await restoredAccount.close()
            let deviceKey = key.publicKey.x963Representation.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let enrollment = AccountEnrollment(identity: key)
            let request = try await enrollment.begin(hubURL: fixture.origin.absoluteString, accountID: accountID, label: "Native probe", allowLoopbackHTTP: true)
            stage("signed-request-approval")
            var approvalRequest = URLRequest(url: fixture.approveURL)
            approvalRequest.httpMethod = "POST"; approvalRequest.httpBody = request
            approvalRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            approvalRequest.setValue(fixture.origin.absoluteString, forHTTPHeaderField: "Origin")
            approvalRequest.setValue("Bearer " + fixture.fixtureToken, forHTTPHeaderField: "Authorization")
            let (approval, response) = try await URLSession.shared.data(for: approvalRequest)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw HubAccountError.malformed }
            stage("independent-pin-verification")
            let accepted = try await enrollment.receive(approval, trustedSignerKey: fixture.rootKey, allowLoopbackHTTP: true)
            stage("publish-roster")
            let published = try await account.publishRoster(accepted.roster)
            guard try published.fingerprint() == accepted.authority.digest else { throw HubAccountError.malformed }
            let trust = try AccountEnrollmentStore(directory: directory, deviceKey: deviceKey, allowLoopbackHTTP: true)
            try await trust.accept(accepted)
            let registry = try HostRegistry(directory: directory, deviceKey: deviceKey, allowLoopbackHTTP: true)
            stage("directory")
            let targets = try await account.hosts()
            guard let target = targets.first(where: { $0.online }) else { throw HubAccountError.malformed }
            stage("encrypted-admission-rpc-reconnect")
            for _ in 0..<2 {
                guard let live = try await account.roster() else { throw HubAccountError.malformed }
                let trusted = try await trust.refresh(live, hubURL: fixture.origin.absoluteString, accountID: accountID)
                let paired = try await HubConnection.admit(account: account, enrollment: trusted, discovered: target, identity: key,
                    persist: { host, grant in try await registry.admitAccount(host: host, grant: grant, enrollment: trusted) },
                    reconcile: { _ in })
                let value = try await paired.connection.request(.sessionGet, sessionID: "session-one")
                guard value["title"]?.string == "Native admitted session" else { throw HubAccountError.malformed }
                await paired.connection.close()
            }
            let hosts = try await registry.hosts()
            guard hosts.count == 1 else { throw HubAccountError.malformed }
            stage("logout")
            try await account.signOut()
            do { _ = try await account.authenticatedAccountID(); throw HubAccountError.malformed }
            catch HubAccountError.authenticationRequired {}
            do { _ = try await account.roster(); throw HubAccountError.malformed }
            catch HubAccountError.authenticationRequired {}
            await account.close()
            print("NATIVE_ROSTER_ADMISSION_PASS: authenticated account, signed request, independent pin, publish, encrypted Agent grant, RPC, reconnect and logout")
        } catch {
            try? await account.signOut(); await account.close(); throw error
        }
    }
}
