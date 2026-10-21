import XCTest
import CryptoKit
@testable import MiaoCore

final class HostRegistryTests: XCTestCase {
    func testSignedInHostNeedsNoPairingAttemptAndRetainsAccountAcrossRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = P256.Signing.PrivateKey().publicKey.x963Representation.base64URL
        let pin = P256.Signing.PrivateKey().publicKey.x963Representation.base64URL
        let grant = try JSONDecoder().decode(DeviceGrant.self, from: JSONSerialization.data(withJSONObject: [
            "id": "account-grant-000001", "version": 1, "publicKey": key, "label": "iPhone",
            "permissions": ["read", "prompt", "session.create"], "projectIDs": ["project-one"], "sessionIDs": ["session-one"],
            "createdAt": 1, "expiresAt": Int64(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000), "revokedAt": NSNull()
        ]))
        let host = ApprovedHost(label: "Computer", hubURL: URL(string: "https://relay.example.invalid")!,
            target: RemoteTarget(hostID: "host-test-000001", runtimeID: "runtime-test-0001"),
            publicKey: pin, grantID: grant.id, grantVersion: 1)
        let registry = try HostRegistry(directory: directory, deviceKey: key)
        try await registry.admitSignedIn(host: host, grant: grant, accountID: "account-owner-0001")
        try await registry.admitSignedIn(host: host, grant: grant, accountID: "account-owner-0001")
        let restarted = try HostRegistry(directory: directory, deviceKey: key)
        let saved = try await restarted.snapshot()
        XCTAssertEqual(saved.hosts.count, 1)
        XCTAssertEqual(saved.hosts.first?.accountID, "account-owner-0001")
        XCTAssertTrue(saved.attempts.isEmpty)
        try await restarted.synchronizeAccount(hubURL: host.hubURL, accountID: "different-account", directory: [])
        let retained = try await restarted.snapshot()
        XCTAssertEqual(retained.hosts.count, 1)
        try await restarted.synchronizeAccount(hubURL: host.hubURL, accountID: "account-owner-0001", directory: [])
        let offline = try await restarted.snapshot()
        XCTAssertEqual(offline.hosts.count, 1, "A transient directory outage must not reset navigation")
        try await restarted.forget(host.id)
        let afterRemoval = try HostRegistry(directory: directory, deviceKey: key)
        let hidden = try await afterRemoval.isAccountHostHidden(hubURL: host.hubURL, accountID: "account-owner-0001", hostID: host.target.hostID)
        XCTAssertTrue(hidden, "Removal must survive an app restart and directory polling")
        let otherAccountHidden = try await afterRemoval.isAccountHostHidden(hubURL: host.hubURL, accountID: "another-account", hostID: host.target.hostID)
        XCTAssertFalse(otherAccountHidden)
        let newRuntime = ApprovedHost(label: host.label, hubURL: host.hubURL,
            target: RemoteTarget(hostID: host.target.hostID, runtimeID: "runtime-restarted"),
            publicKey: host.publicKey, grantID: grant.id, grantVersion: grant.version)
        try await afterRemoval.admitSignedIn(host: newRuntime, grant: grant, accountID: "account-owner-0001")
        let stillRemoved = try await afterRemoval.snapshot()
        XCTAssertTrue(stillRemoved.hosts.isEmpty, "A concurrent/next auto-admission must not undo removal")
        try await afterRemoval.restoreAccountHosts(hubURL: host.hubURL, accountID: "another-account")
        let stillHidden = try await afterRemoval.isAccountHostHidden(hubURL: host.hubURL, accountID: "account-owner-0001", hostID: host.target.hostID)
        XCTAssertTrue(stillHidden)
        try await afterRemoval.restoreAccountHosts(hubURL: host.hubURL, accountID: "account-owner-0001")
        try await afterRemoval.admitSignedIn(host: newRuntime, grant: grant, accountID: "account-owner-0001")
        let restored = try await afterRemoval.snapshot()
        XCTAssertEqual(restored.hosts.count, 1, "Explicitly connecting account computers restores locally removed entries")
    }

    func testTrustAnchorPrecedesApprovalAndOnlyPublicMetadataSurvivesRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let deviceKey = P256.Signing.PrivateKey().publicKey.x963Representation.base64URL
        let pin = P256.Signing.PrivateKey().publicKey.x963Representation.base64URL
        let secret = String(repeating: "a", count: 64)
        let invitation = try JSONDecoder().decode(PairingInvitation.self, from: JSONSerialization.data(withJSONObject: [
            "version": 1, "pairingID": "pairing-test-0001", "secret": secret,
            "hubURL": "https://relay.example.invalid", "hostID": "host-test-000001", "runtimeID": "runtime-test-0001",
            "hostPublicKey": pin, "expiresAt": Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        ]))
        let grant = try JSONDecoder().decode(DeviceGrant.self, from: JSONSerialization.data(withJSONObject: [
            "id": "grant-test-000001", "version": 1, "publicKey": deviceKey, "label": "iPhone",
            "permissions": ["read", "prompt"], "projectIDs": [], "sessionIDs": ["session-one"],
            "createdAt": 1, "expiresAt": Int64(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000), "revokedAt": NSNull()
        ]))
        let host = ApprovedHost(label: "Computer", hubURL: URL(string: invitation.hubURL)!, target: invitation.target,
                                publicKey: pin, grantID: grant.id, grantVersion: grant.version)
        let registry = try HostRegistry(directory: directory, deviceKey: deviceKey)
        do { try await registry.approve(host: host, grant: grant, pairingID: invitation.pairingID); XCTFail("Missing trust anchor must fail") }
        catch { XCTAssertEqual(error as? ClientStateError, .scopeMismatch) }
        try await registry.begin(invitation)
        let recovering = try HostRegistry(directory: directory, deviceKey: deviceKey)
        let pending = try await recovering.snapshot()
        XCTAssertEqual(pending.attempts.first?.hostPublicKey, pin)
        XCTAssertTrue(pending.hosts.isEmpty)
        try await recovering.approve(host: host, grant: grant, pairingID: invitation.pairingID)
        let restarted = try HostRegistry(directory: directory, deviceKey: deviceKey)
        let saved = try await restarted.snapshot()
        XCTAssertEqual(saved.hosts, [AuthorizedHost(host: host, grant: grant)])
        XCTAssertTrue(saved.attempts.isEmpty)
        let file = directory.appendingPathComponent("hosts-v1.json")
        let json = try String(contentsOf: file)
        XCTAssertFalse(json.contains(secret))
        XCTAssertFalse(json.contains("secret"))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let otherDevice = try HostRegistry(directory: directory, deviceKey: "different-device")
        do { _ = try await otherDevice.snapshot(); XCTFail("Another identity must not reuse this grant") }
        catch { XCTAssertEqual(error as? ClientStateError, .scopeMismatch) }
        try await restarted.forget(host.id)
        let removed = try await restarted.snapshot()
        XCTAssertTrue(removed.hosts.isEmpty)
    }
}
