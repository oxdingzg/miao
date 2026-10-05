import XCTest
import CryptoKit
@testable import MiaoCore

final class PushRegistrationTests: XCTestCase {
    func testTokenEncodingPreservesEveryByteAndRejectsInvalidIdentityAndSize() throws {
        let deviceID = P256.Signing.PrivateKey().publicKey.x963Representation.base64URL
        let token = Data((0..<32).map(UInt8.init))
        let registration = try PushDeviceRegistration(deviceID: deviceID, token: token, environment: .sandbox)
        XCTAssertEqual(registration.token, "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
        XCTAssertEqual(registration.deviceID, deviceID)
        for count in [0, 15, 257] {
            XCTAssertThrowsError(try PushDeviceRegistration(deviceID: deviceID, token: Data(repeating: 0, count: count), environment: .production))
        }
        for invalid in ["bad", Data(repeating: 0, count: 65).base64URL, deviceID + "="] {
            XCTAssertThrowsError(try PushDeviceRegistration(deviceID: invalid, token: token, environment: .sandbox))
        }
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(registration)) as? [String: String])
        XCTAssertEqual(Set(body.keys), Set(["deviceID", "token", "environment"]))
        XCTAssertEqual(body["environment"], "sandbox")
    }

    func testUnsignedAccountRejectsPushOperationsBeforeNetwork() async throws {
        let account = try HubAccount(origin: URL(string: "https://example.invalid")!)
        let deviceID = P256.Signing.PrivateKey().publicKey.x963Representation.base64URL
        let registration = try PushDeviceRegistration(deviceID: deviceID, token: Data(repeating: 0xab, count: 32), environment: .sandbox)
        do { _ = try await account.pushRegistrationAvailable(); XCTFail("Unsigned capability request") }
        catch { XCTAssertEqual(error as? HubAccountError, .authenticationRequired) }
        do { _ = try await account.registerPush(registration); XCTFail("Unsigned push registration") }
        catch { XCTAssertEqual(error as? HubAccountError, .authenticationRequired) }
        do { try await account.revokePush(deviceID: deviceID); XCTFail("Unsigned push revocation") }
        catch { XCTAssertEqual(error as? HubAccountError, .authenticationRequired) }
        do { try await account.revokePush(deviceID: "bad"); XCTFail("Malformed device identity") }
        catch { XCTAssertEqual(error as? HubAccountError, .malformed) }
        await account.close()
    }
}
