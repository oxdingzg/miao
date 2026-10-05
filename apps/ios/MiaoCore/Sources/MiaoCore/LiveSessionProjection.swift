import Foundation

/// A transport snapshot. Deliberately not Codable: checkpoints contain durable history only.
public struct LiveSessionProjection: Sendable {
    private let messageID: String?
    private let parts: [JSONValue]

    public init(_ value: JSONValue?) throws {
        guard let value else { messageID = nil; parts = []; return }
        guard let epoch = value["epoch"]?.string, !epoch.isEmpty, epoch.utf8.count <= 64,
              let revision = value["revision"]?.number, revision >= 0,
              revision <= 9_007_199_254_740_991, revision.rounded() == revision,
              let raw = value["parts"]?.array, raw.count <= 32 else {
            throw RemoteConnectionError.protocolIncompatible
        }
        if value["messageID"] == .null { messageID = nil }
        else {
            guard let id = value["messageID"]?.string, !id.isEmpty, id.utf8.count <= 256 else {
                throw RemoteConnectionError.protocolIncompatible
            }
            messageID = id
        }
        guard messageID != nil || raw.isEmpty else { throw RemoteConnectionError.protocolIncompatible }
        var seen = Set<String>()
        var bytes = 0
        for part in raw {
            guard let id = part["id"]?.string, !id.isEmpty, id.utf8.count <= 256,
                  let kind = part["kind"]?.string, ["text", "reasoning"].contains(kind),
                  let text = part["text"]?.string, text.utf8.count <= 256 * 1024,
                  part["truncated"]?.bool != nil, seen.insert(kind + ":" + id).inserted else {
                throw RemoteConnectionError.protocolIncompatible
            }
            bytes += text.utf8.count
        }
        guard bytes <= 4 * 1024 * 1024 else { throw RemoteConnectionError.protocolIncompatible }
        parts = raw
    }

    public func displaying(_ messages: [JSONValue]) -> [JSONValue] {
        messages.map { message in
            guard message["id"]?.string == messageID, message["type"]?.string == "assistant",
                  message["time"]?["completed"] == nil, var value = message.object else { return message }
            value["content"] = .array((message["content"]?.array ?? []).map { part in
                guard var content = part.object,
                      let live = parts.first(where: { $0["id"] == part["id"] && $0["kind"] == part["type"] }),
                      part["text"]?.string == "" else { return part }
                content["text"] = live["text"]
                if live["truncated"]?.bool == true {
                    content["text"] = .string((live["text"]?.string ?? "") + "\n实时预览已达长度上限，完整内容将在完成后同步。")
                }
                return .object(content)
            })
            return .object(value)
        }
    }
}
