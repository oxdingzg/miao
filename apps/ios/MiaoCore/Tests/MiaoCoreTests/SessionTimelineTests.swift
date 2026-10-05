import XCTest
@testable import MiaoCore

final class SessionTimelineTests: XCTestCase {
    private func event(_ type: String, _ seq: Int, _ data: [String: JSONValue] = [:], session: String = "session", version: Int = 1) -> JSONValue {
        .object(["type": .string("session.next." + type),
            "durable": .object(["aggregateID": .string(session), "seq": .number(Double(seq)), "version": .number(Double(version))]),
            "data": .object(data.merging(["sessionID": .string(session), "timestamp": .number(Double(seq))]) { _, new in new })])
    }
    private func page(_ events: [JSONValue]) -> JSONValue { .object(["data": .array(events), "hasMore": .bool(false)]) }

    func testInterruptedPageNeverAdvancesCursorOrPartiallyUpdatesMessages() throws {
        var timeline = SessionTimeline()
        try timeline.apply(page([event("prompted", 2, ["messageID": .string("msg_user"), "prompt": .object(["text": .string("hello")])])]), sessionID: "session")
        let before = timeline
        for invalid in [event("unrecognized", 9), event("prompted", 8, session: "other"), event("prompted", 2), event("text.ended", 10, version: 99)] {
            XCTAssertThrowsError(try timeline.apply(page([event("info.updated", 5, ["title": .string("partial")]), invalid]), sessionID: "session"))
            XCTAssertEqual(timeline, before)
        }
    }

    func testSparseCursorAndLateSettlementReferToExactAssistant() throws {
        var timeline = SessionTimeline()
        let events = [
            event("step.started", 3, ["assistantMessageID": .string("msg_first")]),
            event("text.started", 5, ["assistantMessageID": .string("msg_first"), "textID": .string("part_first")]),
            event("text.ended", 9, ["assistantMessageID": .string("msg_first"), "textID": .string("part_first"), "text": .string("你好 👋")]),
            event("step.started", 12, ["assistantMessageID": .string("msg_second")]),
            event("step.failed", 15, ["assistantMessageID": .string("msg_first"), "error": .object(["type": .string("unknown"), "message": .string("stopped")])], version: 2)
        ]
        try timeline.apply(page(events), sessionID: "session")
        XCTAssertEqual(timeline.cursor, 15)
        XCTAssertEqual(timeline.messages[0]["content"]?.array?.first?["text"]?.string, "你好 👋")
        XCTAssertEqual(timeline.messages[0]["finish"]?.string, "error")
        XCTAssertNil(timeline.messages[1]["finish"])
        let saved = try JSONDecoder().decode(SessionTimeline.self, from: JSONEncoder().encode(timeline))
        XCTAssertEqual(saved, timeline)
    }

    func testRevertCommitDropsTargetAndFollowingMessagesWithoutExecutingAnything() throws {
        var timeline = SessionTimeline()
        try timeline.apply(page([
            event("prompted", 1, ["messageID": .string("msg_first"), "prompt": .object(["text": .string("keep")])]),
            event("prompted", 4, ["messageID": .string("msg_second"), "prompt": .object(["text": .string("drop")])]),
            event("revert.staged", 5, ["revert": .object(["messageID": .string("msg_second")])]),
            event("revert.committed", 8, ["messageID": .string("msg_second")])
        ]), sessionID: "session")
        XCTAssertEqual(timeline.messages.count, 1)
        XCTAssertEqual(timeline.messages[0]["text"]?.string, "keep")
        XCTAssertNil(timeline.revert)
        XCTAssertEqual(timeline.cursor, 8)
    }
}
