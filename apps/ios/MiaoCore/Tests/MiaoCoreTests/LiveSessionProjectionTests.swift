import XCTest
@testable import MiaoCore

final class LiveSessionProjectionTests: XCTestCase {
    private func snapshot(_ text: String, message: String = "reply") -> JSONValue {
        .object(["epoch": .string("epoch"), "revision": .number(1), "messageID": .string(message),
            "parts": .array([.object(["id": .string("part"), "kind": .string("text"), "text": .string(text), "truncated": .bool(false)])])])
    }
    private var messages: [JSONValue] {
        [.object(["id": .string("reply"), "type": .string("assistant"), "content": .array([
            .object(["id": .string("part"), "type": .string("text"), "text": .string("")])])])]
    }
    func testTransientValuesReplaceWithoutChangingDurableSource() throws {
        let original = messages
        let first = try LiveSessionProjection(snapshot("hello"))
        let second = try LiveSessionProjection(snapshot("hello world"))
        XCTAssertEqual(first.displaying(original)[0]["content"]?.array?.first?["text"]?.string, "hello")
        XCTAssertEqual(second.displaying(original)[0]["content"]?.array?.first?["text"]?.string, "hello world")
        XCTAssertEqual(original[0]["content"]?.array?.first?["text"]?.string, "")
        XCTAssertEqual(try LiveSessionProjection(nil).displaying(original), original)
        XCTAssertEqual(try LiveSessionProjection(snapshot("wrong", message: "other")).displaying(original), original)
    }
    func testDurableSettlementWinsOverStaleLiveSnapshot() throws {
        let settled: [JSONValue] = [.object(["id": .string("reply"), "type": .string("assistant"),
            "content": .array([.object(["id": .string("part"), "type": .string("text"), "text": .string("completed")])])])]
        XCTAssertEqual(try LiveSessionProjection(snapshot("partial")).displaying(settled), settled)
    }
    func testRejectsInvalidSnapshotAndOversizedText() {
        XCTAssertThrowsError(try LiveSessionProjection(.object([:])))
        XCTAssertThrowsError(try LiveSessionProjection(snapshot(String(repeating: "猫", count: 100_000))))
        XCTAssertThrowsError(try LiveSessionProjection(.object(["epoch": .string("e"), "revision": .number(-1),
            "messageID": .null, "parts": .array([])])))
    }
}
