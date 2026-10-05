import Foundation

/// Durable full-value boundaries, never provider work. A page replaces state only after every event succeeds.
public struct SessionTimeline: Codable, Sendable, Equatable {
    public private(set) var messages: [JSONValue] = []
    public private(set) var cursor: Int64 = 0
    public private(set) var title: String = ""
    public private(set) var revert: JSONValue?
    public init() {}

    public mutating func apply(_ page: JSONValue, sessionID: String) throws {
        guard let events = page["data"]?.array, events.count <= 100,
              page["hasMore"]?.bool != nil else { throw RemoteConnectionError.protocolIncompatible }
        var next = self
        for event in events {
            guard let durable = event["durable"], let sequence = durable["seq"]?.number,
                  sequence > Double(next.cursor), sequence <= 9_007_199_254_740_991, sequence.rounded() == sequence,
                  durable["aggregateID"]?.string == sessionID, event["data"]?["sessionID"]?.string == sessionID,
                  let type = event["type"]?.string, let version = durable["version"]?.number,
                  version == 1 || (version == 2 && ["session.next.step.ended", "session.next.step.failed"].contains(type)),
                  let data = event["data"]?.object else { throw RemoteConnectionError.protocolIncompatible }
            try next.update(type: type, data: data, metadata: event["metadata"])
            next.cursor = Int64(sequence)
        }
        guard next.messages.count <= 10_000 else { throw ClientStateError.limitExceeded }
        self = next
    }

    private mutating func update(type: String, data: [String: JSONValue], metadata: JSONValue?) throws {
        let timestamp = data["timestamp"] ?? .number(0)
        func required(_ key: String) throws -> String {
            guard let value = data[key]?.string, !value.isEmpty else { throw RemoteConnectionError.protocolIncompatible }
            return value
        }
        func base(_ id: String, _ type: String) -> [String: JSONValue] {
            var value: [String: JSONValue] = ["id": .string(id), "type": .string(type), "time": .object(["created": timestamp])]
            value["metadata"] = metadata
            return value
        }
        switch type {
        case "session.next.created": title = data["info"]?["title"]?.string ?? title
        case "session.next.info.updated": title = data["title"]?.string ?? title
        case "session.next.prompt.admitted", "session.next.moved", "session.next.retried", "session.next.compaction.started": break
        case "session.next.revert.staged": revert = data["revert"]
        case "session.next.revert.cleared": revert = nil
        case "session.next.revert.committed":
            let id = try required("messageID")
            if let index = messages.firstIndex(where: { $0["id"]?.string == id }) { messages.removeSubrange(index...) }
            revert = nil
        case "session.next.prompted":
            var value = base(try required("messageID"), "user")
            value.merge(data["prompt"]?.object ?? [:]) { _, new in new }
            try append(value)
        case "session.next.agent.switched", "session.next.model.switched":
            let field = type == "session.next.agent.switched" ? "agent" : "model"
            var value = base(try required("messageID"), field + "-switched")
            value[field] = data[field]
            try append(value)
        case "session.next.context.updated", "session.next.synthetic":
            var value = base(try required("messageID"), type == "session.next.synthetic" ? "synthetic" : "system")
            value["text"] = data["text"]
            if type == "session.next.synthetic" { value["sessionID"] = data["sessionID"]; value["metadata"] = data["metadata"] }
            try append(value)
        case "session.next.shell.started":
            var value = base(try required("messageID"), "shell")
            value["callID"] = data["callID"]; value["command"] = data["command"]; value["output"] = .string("")
            try append(value)
        case "session.next.shell.ended":
            let id = try required("callID")
            if let index = messages.lastIndex(where: { $0["type"]?.string == "shell" && $0["callID"]?.string == id }),
               var value = messages[index].object {
                value["output"] = data["output"]
                var time = value["time"]?.object ?? [:]; time["completed"] = timestamp; value["time"] = .object(time)
                messages[index] = .object(value)
            }
        case "session.next.step.started":
            if let index = messages.lastIndex(where: { $0["type"]?.string == "assistant" }),
               var value = messages[index].object, value["time"]?["completed"] == nil {
                var time = value["time"]?.object ?? [:]; time["completed"] = timestamp; value["time"] = .object(time)
                messages[index] = .object(value)
            }
            var value = base(try required("assistantMessageID"), "assistant")
            value["metadata"] = nil; value["agent"] = data["agent"]; value["model"] = data["model"]; value["content"] = .array([])
            if let start = data["snapshot"] { value["snapshot"] = .object(["start": start]) }
            try append(value)
        case "session.next.step.ended", "session.next.step.failed":
            try assistant(required("assistantMessageID")) { value in
                var time = value["time"]?.object ?? [:]; time["completed"] = timestamp; value["time"] = .object(time)
                if type == "session.next.step.failed" { value["finish"] = .string("error"); value["error"] = data["error"] }
                else {
                    for key in ["finish", "cost", "tokens", "ttft"] { value[key] = data[key] }
                    if data["snapshot"] != nil || data["files"] != nil {
                        var snapshot = value["snapshot"]?.object ?? [:]
                        snapshot["end"] = data["snapshot"]; snapshot["files"] = data["files"]; value["snapshot"] = .object(snapshot)
                    }
                }
            }
        case "session.next.text.started", "session.next.reasoning.started", "session.next.tool.input.started":
            let kind = type == "session.next.text.started" ? "text" : type == "session.next.reasoning.started" ? "reasoning" : "tool"
            let id = try required(kind == "text" ? "textID" : kind == "reasoning" ? "reasoningID" : "callID")
            var part: [String: JSONValue] = ["type": .string(kind), "id": .string(id)]
            if kind == "tool" {
                part["name"] = data["name"]; part["time"] = .object(["created": timestamp])
                part["state"] = .object(["status": .string("pending"), "input": .string("")])
            } else {
                part["text"] = .string("")
                if kind == "reasoning" { part["time"] = .object(["created": timestamp]); part["providerMetadata"] = data["providerMetadata"] }
            }
            try assistant(required("assistantMessageID")) { value in
                value["content"] = .array((value["content"]?.array ?? []) + [.object(part)])
            }
        case "session.next.text.ended", "session.next.reasoning.ended", "session.next.tool.input.ended",
             "session.next.tool.called", "session.next.tool.progress", "session.next.tool.success", "session.next.tool.failed":
            let kind = type == "session.next.text.ended" ? "text" : type == "session.next.reasoning.ended" ? "reasoning" : "tool"
            let id = try required(kind == "text" ? "textID" : kind == "reasoning" ? "reasoningID" : "callID")
            try assistant(required("assistantMessageID")) { value in
                var parts = value["content"]?.array ?? []
                guard let index = parts.lastIndex(where: { $0["id"]?.string == id && $0["type"]?.string == kind }),
                      var part = parts[index].object else { return }
                if kind != "tool" {
                    part["text"] = data["text"]
                    if kind == "reasoning" {
                        part["time"] = .object(["created": part["time"]?["created"] ?? timestamp, "completed": timestamp])
                        if let provider = data["providerMetadata"] { part["providerMetadata"] = provider }
                    }
                } else {
                    var state = part["state"]?.object ?? [:]
                    var time = part["time"]?.object ?? [:]
                    switch type {
                    case "session.next.tool.input.ended": if state["status"]?.string == "pending" { state["input"] = data["text"] }
                    case "session.next.tool.called":
                        state = ["status": .string("running"), "input": data["input"] ?? .object([:]), "structured": .object([:]), "content": .array([])]
                        part["provider"] = data["provider"]; time["ran"] = timestamp
                    case "session.next.tool.progress":
                        if state["status"]?.string == "running" { state["structured"] = data["structured"]; state["content"] = data["content"] }
                    case "session.next.tool.success", "session.next.tool.failed":
                        let failed = type == "session.next.tool.failed"
                        if state["status"]?.string == "running" || (failed && state["status"]?.string == "pending") {
                            let provider = part["provider"]
                            var final: [String: JSONValue] = ["status": .string(failed ? "error" : "completed"),
                                "input": state["input"]?.object == nil ? .object([:]) : state["input"]!,
                                "structured": failed ? state["structured"] ?? .object([:]) : data["structured"] ?? .object([:]),
                                "content": failed ? state["content"] ?? .array([]) : data["content"] ?? .array([])]
                            final["error"] = failed ? data["error"] : nil; final["result"] = data["result"]
                            if !failed { final["outputPaths"] = data["outputPaths"] ?? .array([]) }
                            state = final; time["completed"] = timestamp
                            var metadata: [String: JSONValue] = ["executed": .bool(provider?["executed"]?.bool == true || data["provider"]?["executed"]?.bool == true)]
                            metadata["metadata"] = provider?["metadata"]; metadata["resultMetadata"] = data["provider"]?["metadata"]
                            part["provider"] = .object(metadata)
                        }
                    default: break
                    }
                    part["state"] = .object(state); part["time"] = .object(time)
                }
                parts[index] = .object(part); value["content"] = .array(parts)
            }
        case "session.next.compaction.ended":
            var value = base(try required("messageID"), "compaction")
            value["summary"] = data["text"]; value["recent"] = data["recent"]; value["reason"] = data["reason"]
            try append(value)
        default: throw RemoteConnectionError.protocolIncompatible
        }
    }

    private mutating func append(_ value: [String: JSONValue]) throws {
        guard !messages.contains(where: { $0["id"] == value["id"] }) else { throw RemoteConnectionError.protocolIncompatible }
        messages.append(.object(value))
    }
    private mutating func assistant(_ id: String, _ update: (inout [String: JSONValue]) -> Void) {
        guard let index = messages.lastIndex(where: { $0["id"]?.string == id && $0["type"]?.string == "assistant" }),
              var value = messages[index].object else { return }
        update(&value)
        messages[index] = .object(value)
    }
}
