import XCTest
import CryptoKit
@testable import MiaoCore

final class HostRegistryTests: XCTestCase {
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
