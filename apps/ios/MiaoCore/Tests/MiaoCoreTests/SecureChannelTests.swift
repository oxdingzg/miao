import XCTest
import CryptoKit
@testable import MiaoCore

final class SecureChannelTests: XCTestCase {
    let target = RemoteTarget(hostID: "host-test-00000000", runtimeID: "runtime-test-00000000")
    let connectionID = "connection-test-00000000"

    func pair() async throws -> (SecureSession, SecureSession) {
        let host = P256.Signing.PrivateKey()
        let device = P256.Signing.PrivateKey()
        let client = try ClientHandshake(identity: device, target: target)
        let accepted = try HostHandshake.accept(identity: host, target: target, connectionID: connectionID,
                                                client: await client.hello, trustedDeviceKey: device.publicKey.x963Representation.base64URL)
        return (try await client.finish(accepted.hello, trustedHostKey: host.publicKey.x963Representation.base64URL), accepted.session)
    }

    func testBidirectionalEncryptionAndReplay() async throws {
        let (client, host) = try await pair()
        let packet = try await client.seal(Data("prompt".utf8))
        let received = try await host.open(packet)
        XCTAssertEqual(received, Data("prompt".utf8))
        do { _ = try await host.open(packet); XCTFail("Replay accepted") }
        catch { XCTAssertEqual(error as? ChannelError, .replay) }
        let reply = try await host.seal(Data("result".utf8))
        let result = try await client.open(reply)
        XCTAssertEqual(result, Data("result".utf8))
    }

    func testDoesNotTrustUnknownDevice() async throws {
        let host = P256.Signing.PrivateKey()
        let device = P256.Signing.PrivateKey()
        let client = try ClientHandshake(identity: device, target: target)
        let hello = await client.hello
        XCTAssertThrowsError(try HostHandshake.accept(identity: host, target: target, connectionID: connectionID,
                                                      client: hello, trustedDeviceKey: host.publicKey.x963Representation.base64URL))
    }

    func testHandshakeFinishesOnceAndRejectsUnknownHost() async throws {
        let host = P256.Signing.PrivateKey()
        let device = P256.Signing.PrivateKey()
        let client = try ClientHandshake(identity: device, target: target)
        let accepted = try HostHandshake.accept(identity: host, target: target, connectionID: connectionID,
                                                client: await client.hello, trustedDeviceKey: device.publicKey.x963Representation.base64URL)
        do { _ = try await client.finish(accepted.hello, trustedHostKey: device.publicKey.x963Representation.base64URL); XCTFail("Unknown host accepted") }
        catch { XCTAssertEqual(error as? ChannelError, .untrustedIdentity) }
        do { _ = try await client.finish(accepted.hello, trustedHostKey: host.publicKey.x963Representation.base64URL); XCTFail("Handshake reused") }
        catch { XCTAssertEqual(error as? ChannelError, .handshakeUsed) }
    }

    func testIsolationOrderingAndTamper() async throws {
        let (client, host) = try await pair()
        let first = try await client.seal(Data("first".utf8))
        let second = try await client.seal(Data("second".utf8))
        do { _ = try await host.open(second); XCTFail("Out-of-order frame accepted") }
        catch { XCTAssertEqual(error as? ChannelError, .replay) }
        do { _ = try await client.open(first); XCTFail("Reflection accepted") } catch {}
        var modified = Array(first)
        modified[15] = modified[15] == "A" ? "B" : "A"
        do { _ = try await host.open(String(modified)); XCTFail("Modified frame accepted") } catch {}
        let result = try await host.open(first)
        XCTAssertEqual(result, Data("first".utf8))
        let (_, other) = try await pair()
        do { _ = try await other.open(first); XCTFail("Foreign connection accepted") } catch {}
    }
}
