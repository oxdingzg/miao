import XCTest
import CryptoKit
@testable import MiaoCore

final class PairingTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func uri(overrides: [String: Any] = [:]) throws -> String {
        let object: [String: Any] = [
            "version": 1, "pairingID": "pairing-test-0001", "secret": String(repeating: "a", count: 64),
            "hubURL": "https://relay.example.invalid", "hostID": "host-test-000001", "runtimeID": "runtime-test-0001",
            "hostPublicKey": P256.Signing.PrivateKey().publicKey.x963Representation.base64URL,
            "expiresAt": Int64(now.timeIntervalSince1970 * 1000) + 120_000
        ].merging(overrides) { _, new in new }
        return "miao://pair#" + (try JSONSerialization.data(withJSONObject: object)).base64URL
    }

    func testExplicitFragmentEntryPointAndPinnedIdentity() throws {
        let invitation = try PairingInvitation.parse(uri(), now: now)
        XCTAssertEqual(invitation.target.hostID, "host-test-000001")
        XCTAssertEqual(invitation.secret, String(repeating: "a", count: 64))
        XCTAssertThrowsError(try PairingInvitation.parse(uri().replacingOccurrences(of: "#", with: "?secret="), now: now))
        XCTAssertThrowsError(try PairingInvitation.parse(uri().replacingOccurrences(of: "miao://pair", with: "https://pair"), now: now))
        XCTAssertThrowsError(try PairingInvitation.parse(uri().replacingOccurrences(of: "miao://pair", with: "miao://owner@pair"), now: now))
        XCTAssertThrowsError(try PairingInvitation.parse(uri(overrides: ["hostPublicKey": String(repeating: "A", count: 87)]), now: now))
        XCTAssertThrowsError(try PairingInvitation.parse(uri(overrides: ["secret": "short"]), now: now))
        XCTAssertThrowsError(try PairingInvitation.parse(uri(overrides: ["runtimeID": "bad"]), now: now))
        XCTAssertThrowsError(try PairingInvitation.parse(uri(overrides: ["expiresAt": 0]), now: now))
    }

    func testRelayRequiresRootTLSAndExplicitLoopbackTestOptIn() throws {
        for url in ["http://relay.example.invalid", "https://user:pass@relay.example.invalid", "https://relay.example.invalid/path",
                    "https://relay.example.invalid?secret=x", "https://relay.example.invalid#secret"] {
            XCTAssertThrowsError(try PairingInvitation.parse(uri(overrides: ["hubURL": url]), now: now))
        }
        let loopback = try uri(overrides: ["hubURL": "http://127.0.0.1:4600"])
        XCTAssertThrowsError(try PairingInvitation.parse(loopback, now: now))
        XCTAssertNoThrow(try PairingInvitation.parse(loopback, now: now, allowLoopbackHTTP: true))
        XCTAssertThrowsError(try PairingInvitation.parse(uri(overrides: ["hubURL": "http://remote.example.invalid"]),
                                                      now: now, allowLoopbackHTTP: true))
    }

    func testGrantMustBelongToThisDeviceAndBeCurrent() throws {
        let key = P256.Signing.PrivateKey().publicKey.x963Representation.base64URL
        let object: [String: Any] = [
            "id": "grant-test-000001", "version": 1, "publicKey": key, "label": "iPhone",
            "permissions": ["read"], "projectIDs": [], "sessionIDs": ["session-one"],
            "createdAt": 1, "expiresAt": Int64(now.timeIntervalSince1970 * 1000) + 3_600_000,
            "revokedAt": NSNull()
        ]
        let grant = try JSONDecoder().decode(DeviceGrant.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNoThrow(try grant.validate(deviceKey: key, now: now))
        XCTAssertThrowsError(try grant.validate(deviceKey: "other-key", now: now))
        XCTAssertThrowsError(try grant.validate(deviceKey: key, now: now.addingTimeInterval(7200)))
        let revoked = object.merging(["revokedAt": 2]) { _, new in new }
        XCTAssertThrowsError(try JSONDecoder().decode(DeviceGrant.self, from: JSONSerialization.data(withJSONObject: revoked))
            .validate(deviceKey: key, now: now))
        let empty = object.merging(["sessionIDs": []]) { _, new in new }
        XCTAssertThrowsError(try JSONDecoder().decode(DeviceGrant.self, from: JSONSerialization.data(withJSONObject: empty))
            .validate(deviceKey: key, now: now))
    }

    func testPairingFramesCannotEnterNormalRPCReader() throws {
        let frame = Data("{\"version\":1,\"type\":\"pairing\",\"status\":\"pending\"}".utf8)
        var normal = ResponseAssembler()
        XCTAssertThrowsError(try normal.append(frame))
        var pairing = ResponseAssembler(allowedTypes: ["pairing"])
        XCTAssertEqual(try pairing.append(frame), frame)
        XCTAssertThrowsError(try pairing.append(Data("{\"version\":1,\"type\":\"result\"}".utf8)))
    }
}
