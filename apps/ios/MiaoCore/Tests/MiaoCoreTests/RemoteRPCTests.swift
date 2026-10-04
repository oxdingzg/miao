import XCTest
@testable import MiaoCore

final class RemoteRPCTests: XCTestCase {
    func testChunksAreAppliedOnlyAfterCompleteOrderedTransfer() throws {
        let transfer = UUID().uuidString
        let response = Data("{\"version\":1,\"type\":\"result\",\"requestID\":\"test\",\"data\":null}".utf8)
        var assembler = ResponseAssembler()
        XCTAssertNil(try assembler.append(chunk(transfer, 0, 2, response.prefix(20))))
        XCTAssertEqual(try assembler.append(chunk(transfer, 1, 2, response.dropFirst(20))), response)
        XCTAssertEqual(try assembler.append(response), response)
        let decoded = try JSONDecoder().decode(RemoteResponse.self, from: response)
        XCTAssertEqual(decoded.data, .null)
    }

    func testRejectsMixedTransfersDuplicateChunksAndUnexpectedInterleaving() throws {
        let transfer = UUID().uuidString
        var mixed = ResponseAssembler()
        _ = try mixed.append(chunk(transfer, 0, 2, Data([1])))
        XCTAssertThrowsError(try mixed.append(chunk(UUID().uuidString, 1, 2, Data([2]))))
        var replay = ResponseAssembler()
        let first = try chunk(transfer, 0, 2, Data([1]))
        _ = try replay.append(first)
        XCTAssertThrowsError(try replay.append(first))
        var interleaved = ResponseAssembler()
        _ = try interleaved.append(first)
        XCTAssertThrowsError(try interleaved.append(Data("{\"version\":1,\"type\":\"result\"}".utf8)))
    }

    func testRejectsUnboundedTransfersMalformedBase64AndProtocolVersions() throws {
        var assembler = ResponseAssembler()
        XCTAssertThrowsError(try assembler.append(chunk(UUID().uuidString, 0, 129, Data([1]))))
        XCTAssertThrowsError(try assembler.append(Data("{\"version\":2,\"type\":\"result\"}".utf8)))
        XCTAssertThrowsError(try decodeBase64URL("AA=="))
        XCTAssertThrowsError(try decodeBase64URL("A"))
        XCTAssertThrowsError(try assembler.append(chunk(UUID().uuidString, 0, 1, Data(repeating: 1, count: 64 * 1024 + 1))))
    }

    func testTypedJSONRoundTripRetainsUnknownFieldsAndUnicode() throws {
        let value = JSONValue.object(["new-field": .array([.null, .bool(true), .number(42), .string("语音 draft 🎙️")])])
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)), value)
    }

    private func chunk(_ transferID: String, _ index: Int, _ total: Int, _ value: Data) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["version": 1, "type": "chunk", "transferID": transferID,
                                                    "index": index, "total": total, "payload": value.base64URL])
    }
}
