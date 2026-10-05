import XCTest
@testable import MiaoCore

final class HubAccountTests: XCTestCase {
    func testAccountEndpointRejectsCredentialsPathsAndInsecureRemoteOrigins() throws {
        for raw in ["http://example.invalid", "https://owner:password@example.invalid",
                    "https://example.invalid/path", "https://example.invalid?token=secret",
                    "https://example.invalid#secret"] {
            XCTAssertThrowsError(try HubAccount(origin: URL(string: raw)!, allowLoopbackHTTP: true))
        }
        XCTAssertNoThrow(try HubAccount(origin: URL(string: "https://example.invalid/")!))
        XCTAssertThrowsError(try HubAccount(origin: URL(string: "http://127.0.0.1:4600")!))
        XCTAssertNoThrow(try HubAccount(origin: URL(string: "http://127.0.0.1:4600")!, allowLoopbackHTTP: true))
    }

    func testEmptyAccountRequiresAuthenticationAndCanSignOutWithoutNetwork() async throws {
        let account = try HubAccount(origin: URL(string: "https://example.invalid")!,
                                     keychainService: "miao.hub.test." + UUID().uuidString)
        let restored = try await account.restore()
        XCTAssertFalse(restored)
        do {
            _ = try await account.bearer()
            XCTFail("Unsigned account supplied a bearer")
        } catch { XCTAssertEqual(error as? HubAccountError, .authenticationRequired) }
        try await account.signOut()
        await account.close()
    }
}
