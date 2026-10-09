import XCTest
import CryptoKit
@testable import MiaoCore

final class AccountRosterTests: XCTestCase {
    private let accountID = "account_aaaaaaaaaaaaaaaaaaaaaaaa"
    private let hubURL = "https://relay.example.invalid"
    private let now = Date(timeIntervalSince1970: 2)
    private func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "account-enrollment", withExtension: "json", subdirectory: "Fixtures"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func data(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object) }

    func testRealJavaScriptSignaturesAndCanonicalFingerprints() throws {
        let value = try fixture()
        let rootKey = try XCTUnwrap(value["rootKey"] as? String)
        let current = try SignedAccountRoster.decode(data(value["current"]!))
        let authority = try current.accept(accountID: accountID, previous: AccountRosterAuthority(accountID: accountID, sequence: 0, digest: "", signerKeys: [rootKey]))
        XCTAssertEqual(authority.digest, value["currentDigest"] as? String)
        let pending = try AccountEnrollmentRequest.decode(data(value["request"]!))
        try pending.verify(hubURL: hubURL, accountID: accountID, now: now)
        let approval = try AccountEnrollmentApproval.decode(data(value["approved"]!))
        let received = try approval.accept(pending: pending, trustedSignerKey: rootKey, now: now)
        XCTAssertEqual(received.authority.sequence, 2)
        XCTAssertEqual(received.authority.digest, value["approvedDigest"] as? String)
        XCTAssertEqual(received.authority.signerKeys, [rootKey])
        XCTAssertEqual(received.hosts.first?.publicKey, value["hostKey"] as? String)
        XCTAssertEqual(received.roster.roster.devices.first(where: { $0.publicKey == value["deviceKey"] as? String })?.signer, false)
        XCTAssertEqual(try approval.roster.accept(accountID: accountID, previous: authority), received.authority)
        XCTAssertEqual(try approval.roster.accept(accountID: accountID, previous: received.authority), received.authority)
        XCTAssertThrowsError(try current.accept(accountID: accountID, previous: received.authority))
    }

    func testWrongSignerForeignAccountExpiryAndChangedHostEndorsement() throws {
        let value = try fixture()
        let rootKey = try XCTUnwrap(value["rootKey"] as? String)
        let pending = try AccountEnrollmentRequest.decode(data(value["request"]!))
        let approval = try AccountEnrollmentApproval.decode(data(value["approved"]!))
        let fake = P256.Signing.PrivateKey().publicKey.x963Representation.base64URL
        XCTAssertThrowsError(try approval.accept(pending: pending, trustedSignerKey: fake, now: now))
        XCTAssertThrowsError(try pending.verify(hubURL: hubURL, accountID: "account_bbbbbbbbbbbbbbbbbbbbbbbb", now: now))
        XCTAssertThrowsError(try pending.verify(hubURL: hubURL, accountID: accountID, now: Date(timeIntervalSince1970: 601)))
        var changed = try XCTUnwrap(value["approved"] as? [String: Any])
        var endorsement = try XCTUnwrap(changed["endorsement"] as? [String: Any])
        var payload = try XCTUnwrap(endorsement["payload"] as? [String: Any])
        var hosts = try XCTUnwrap(payload["hosts"] as? [[String: Any]])
        hosts[0]["publicKey"] = fake
        payload["hosts"] = hosts; endorsement["payload"] = payload; changed["endorsement"] = endorsement
        XCTAssertThrowsError(try AccountEnrollmentApproval.decode(data(changed)).accept(pending: pending, trustedSignerKey: rootKey, now: now))
    }

    func testStrictShapeAndSameSequenceForkRejection() throws {
        let value = try fixture()
        let rootKey = try XCTUnwrap(value["rootKey"] as? String)
        let approved = try AccountEnrollmentApproval.decode(data(value["approved"]!))
        let accepted = try approved.roster.accept(accountID: accountID, previous: AccountRosterAuthority(accountID: accountID, sequence: 0, digest: "", signerKeys: [rootKey]))
        var signed = try XCTUnwrap((value["approved"] as? [String: Any])?["roster"] as? [String: Any])
        var payload = try XCTUnwrap(signed["roster"] as? [String: Any])
        payload["injected"] = true; signed["roster"] = payload
        XCTAssertThrowsError(try SignedAccountRoster.decode(data(signed)))
        payload.removeValue(forKey: "injected")
        var devices = try XCTUnwrap(payload["devices"] as? [[String: Any]])
        devices[0]["label"] = "Same sequence fork"
        payload["devices"] = devices; signed["roster"] = payload
        XCTAssertThrowsError(try SignedAccountRoster.decode(data(signed)).accept(accountID: accountID, previous: accepted))
        devices.append(devices[0]); payload["devices"] = devices; signed["roster"] = payload
        XCTAssertThrowsError(try SignedAccountRoster.decode(data(signed)))
    }

    func testNativeSignerAndPendingActorConsumeOnceAndCancel() async throws {
        let root = P256.Signing.PrivateKey()
        let recipient = P256.Signing.PrivateKey()
        let host = P256.Signing.PrivateKey()
        let current = try SignedAccountRoster.sign(identity: root, roster: AccountRosterPayload(accountID: accountID, sequence: 1, issuedAt: 0,
            devices: [AccountRosterDevice(publicKey: root.publicKey.x963Representation.base64URL, label: "Root", signer: true, addedAt: 0)]))
        let authority = try current.accept(accountID: accountID, previous: AccountRosterAuthority(accountID: accountID, sequence: 0, digest: "", signerKeys: [root.publicKey.x963Representation.base64URL]))
        let enrollment = AccountEnrollment(identity: recipient)
        let request = try AccountEnrollmentRequest.decode(await enrollment.begin(hubURL: hubURL, accountID: accountID, label: "Phone", now: now))
        let approval = try AccountEnrollmentApproval.approve(identity: root, request: request, hubURL: hubURL, current: current, authority: authority,
            pairedHosts: [EndorsedAccountHost(hostID: "host_aaaaaaaaaaaaaaaaaaaaaaaa", publicKey: host.publicKey.x963Representation.base64URL)], now: now)
        let packet = try JSONEncoder().encode(approval)
        let accepted = try await enrollment.receive(packet, trustedSignerKey: root.publicKey.x963Representation.base64URL, now: now)
        XCTAssertEqual(accepted.authority.sequence, 2)
        do { _ = try await enrollment.receive(packet, trustedSignerKey: root.publicKey.x963Representation.base64URL, now: now); XCTFail("Replay accepted") }
        catch { XCTAssertEqual(error as? AccountRosterError, .noPendingRequest) }
        _ = try await enrollment.begin(hubURL: hubURL, accountID: accountID, label: "Again", now: now)
        await enrollment.cancel()
        do { _ = try await enrollment.receive(packet, trustedSignerKey: root.publicKey.x963Representation.base64URL, now: now); XCTFail("Cancelled request accepted") }
        catch { XCTAssertEqual(error as? AccountRosterError, .noPendingRequest) }
    }

    func testAtomicAccountTrustReloadIsolationAndRollbackRejection() async throws {
        let value = try fixture()
        let rootKey = try XCTUnwrap(value["rootKey"] as? String)
        let deviceKey = try XCTUnwrap(value["deviceKey"] as? String)
        let pending = try AccountEnrollmentRequest.decode(data(value["request"]!))
        let accepted = try AccountEnrollmentApproval.decode(data(value["approved"]!)).accept(pending: pending, trustedSignerKey: rootKey, now: now)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try AccountEnrollmentStore(directory: directory, deviceKey: deviceKey)
        try await store.accept(accepted)
        let restored = try AccountEnrollmentStore(directory: directory, deviceKey: deviceKey)
        let saved = try await restored.account(hubURL: hubURL, accountID: accountID)
        XCTAssertEqual(saved, accepted)
        let foreign = try await restored.account(hubURL: hubURL, accountID: "account_bbbbbbbbbbbbbbbbbbbbbbbb")
        XCTAssertNil(foreign)
        let lower = try SignedAccountRoster.decode(data(value["current"]!))
        do { _ = try await restored.refresh(lower, hubURL: hubURL, accountID: accountID); XCTFail("Rollback accepted") }
        catch { XCTAssertEqual(error as? AccountRosterError, .staleOrForked) }
        let wrongDevice = try AccountEnrollmentStore(directory: directory, deviceKey: rootKey)
        do { _ = try await wrongDevice.account(hubURL: hubURL, accountID: accountID); XCTFail("Other identity read trust") }
        catch { XCTAssertNotNil(error as? ClientStateError) }
    }

    func testAuthenticatedMemberRemovalPersistsItsSequenceAndRejectsLaterRollback() async throws {
        let root = P256.Signing.PrivateKey(), recipient = P256.Signing.PrivateKey(), host = P256.Signing.PrivateKey()
        let rootKey = root.publicKey.x963Representation.base64URL
        let deviceKey = recipient.publicKey.x963Representation.base64URL
        let current = try SignedAccountRoster.sign(identity: root, roster: AccountRosterPayload(accountID: accountID, sequence: 1, issuedAt: 0,
            devices: [AccountRosterDevice(publicKey: rootKey, label: "Root", signer: true, addedAt: 0)]))
        let authority = try current.accept(accountID: accountID, previous: AccountRosterAuthority(accountID: accountID, sequence: 0, digest: "", signerKeys: [rootKey]))
        let request = try AccountEnrollmentRequest.create(identity: recipient, hubURL: hubURL, accountID: accountID, label: "Phone", now: now)
        let approved = try AccountEnrollmentApproval.approve(identity: root, request: request, hubURL: hubURL, current: current, authority: authority,
            pairedHosts: [EndorsedAccountHost(hostID: "host_aaaaaaaaaaaaaaaaaaaaaaaa", publicKey: host.publicKey.x963Representation.base64URL)], now: now)
        let accepted = try approved.accept(pending: request, trustedSignerKey: rootKey, now: now)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try AccountEnrollmentStore(directory: directory, deviceKey: deviceKey)
        try await store.accept(accepted)
        let removed = try SignedAccountRoster.sign(identity: root, roster: AccountRosterPayload(accountID: accountID, sequence: 3, issuedAt: 3000, devices: current.roster.devices))
        let updated = try await store.refresh(removed, hubURL: hubURL, accountID: accountID)
        XCTAssertEqual(updated.authority.sequence, 3)
        XCTAssertFalse(updated.roster.roster.devices.contains { $0.publicKey == deviceKey })
        let restored = try AccountEnrollmentStore(directory: directory, deviceKey: deviceKey)
        let saved = try await restored.account(hubURL: hubURL, accountID: accountID)
        XCTAssertEqual(saved?.authority.sequence, 3)
        do { _ = try await restored.refresh(approved.roster, hubURL: hubURL, accountID: accountID); XCTFail("Removed membership was restored by rollback") }
        catch { XCTAssertEqual(error as? AccountRosterError, .staleOrForked) }
    }

    func testHTTPNeedsExplicitLoopbackOptIn() throws {
        let key = P256.Signing.PrivateKey()
        XCTAssertThrowsError(try AccountEnrollmentRequest.create(identity: key, hubURL: "http://127.0.0.1:4600", accountID: accountID, label: "Phone", now: now))
        XCTAssertThrowsError(try AccountEnrollmentRequest.create(identity: key, hubURL: "http://relay.example.invalid", accountID: accountID, label: "Phone", now: now, allowLoopbackHTTP: true))
        _ = try AccountEnrollmentRequest.create(identity: key, hubURL: "http://127.0.0.1:4600", accountID: accountID, label: "Phone", now: now, allowLoopbackHTTP: true)
    }
}
