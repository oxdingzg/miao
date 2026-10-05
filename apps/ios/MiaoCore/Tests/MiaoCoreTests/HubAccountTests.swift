import XCTest
import CryptoKit
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

    func testRelayRequestKeepsBearerOutOfURLsAndRejectsDifferentOrigins() async throws {
        let account = try HubAccount(origin: URL(string: "https://relay.invalid")!)
        let hostID = "host_abcdefghijklmnop"
        let request = try await account.relayRequest(hubURL: URL(string: "HTTPS://RELAY.invalid:443/")!,
                                                    hostID: hostID, token: "short.jwt.token")
        XCTAssertEqual(request.url?.scheme, "wss")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer short.jwt.token")
        XCTAssertFalse(request.url!.absoluteString.contains("short.jwt.token"))
        for raw in ["https://other.invalid", "https://relay.invalid:8443", "http://relay.invalid",
                    "https://relay.invalid/path", "https://user@relay.invalid", "https://relay.invalid?token=secret"] {
            do {
                _ = try await account.relayRequest(hubURL: URL(string: raw)!, hostID: hostID, token: "short.jwt.token")
                XCTFail("Accepted a different relay origin")
            } catch { XCTAssertEqual(error as? HubAccountError, .invalidEndpoint) }
        }
        do {
            _ = try await account.relayRequest(hubURL: URL(string: "https://relay.invalid")!, hostID: hostID, token: "bad\r\nheader")
            XCTFail("Accepted a header injection")
        } catch { XCTAssertEqual(error as? HubAccountError, .invalidEndpoint) }
        await account.close()
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

    func testUnsignedAccountBlocksRelayBeforeOpeningTheSocket() async throws {
        let account = try HubAccount(origin: URL(string: "https://relay.invalid")!)
        let identity = P256.Signing.PrivateKey()
        let host = ApprovedHost(label: "Test", hubURL: URL(string: "https://relay.invalid")!,
            target: RemoteTarget(hostID: UUID().uuidString, runtimeID: UUID().uuidString),
            publicKey: identity.publicKey.x963Representation.base64URL, grantID: UUID().uuidString, grantVersion: 1)
        do {
            let socket = try await HubConnection.open(host: host, identity: identity, account: account) { _ in }
            await socket.close()
            XCTFail("Opened an unsigned relay")
        } catch RemoteConnectionError.authorizationBlocked {}
        await account.close()
    }

    func testEquivalentOriginsShareTheSameKeychainPartitionAndOriginHeader() async throws {
        let account = try HubAccount(origin: URL(string: "HTTPS://EXAMPLE.invalid:443/")!)
        let canonical = await account.origin
        XCTAssertEqual(canonical.absoluteString, "https://example.invalid")
        let local = try HubAccount(origin: URL(string: "http://LOCALHOST:80/")!, allowLoopbackHTTP: true)
        let loopback = await local.origin
        XCTAssertEqual(loopback.absoluteString, "http://localhost")
        XCTAssertThrowsError(try HubAccount(origin: URL(string: "https://example.invalid:0")!))
    }
}
