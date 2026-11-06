import Foundation
import Observation

/// On-device assistant: it talks to a provider the owner configured on the phone
/// and runs its tools against the app's own sandbox. Nothing here needs a
/// computer, an account, or the relay.
struct LocalProvider: Codable, Sendable, Equatable {
    var baseURL: String = "https://api.openai.com/v1"
    var apiKey: String = ""
    var model: String = ""
}

struct LocalMessage: Codable, Sendable, Equatable, Identifiable {
    enum Role: String, Codable, Sendable { case user, assistant, tool }
    var id = UUID()
    var role: Role
    var text: String
    var toolName: String?
}

@MainActor @Observable
final class LocalAgent {
    private(set) var provider = LocalProvider()
    private(set) var messages: [LocalMessage] = []
    private(set) var busy = false
    var error: String?

    /// Every tool resolves inside this directory, so a path from the model can
    /// never escape the app's own storage.
    let workspace: URL
    private var task: Task<Void, Never>?

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        workspace = support.appendingPathComponent("LocalAgent/workspace", isDirectory: true)
        try? FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        load()
    }

    var ready: Bool { !provider.model.isEmpty && !provider.apiKey.isEmpty && !provider.baseURL.isEmpty }

    // MARK: persistence

    private var configURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LocalAgent/config.json")
    }
    private var historyURL: URL { configURL.deletingLastPathComponent().appendingPathComponent("history.json") }

    func save(_ next: LocalProvider) {
        provider = next
        if let data = try? JSONEncoder().encode(next) {
            try? FileManager.default.createDirectory(at: configURL.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            try? data.write(to: configURL, options: [.atomic, .completeFileProtection])
        }
    }

    private func load() {
        if let data = try? Data(contentsOf: configURL),
           let value = try? JSONDecoder().decode(LocalProvider.self, from: data) {
            provider = value
        }
        if let data = try? Data(contentsOf: historyURL),
           let value = try? JSONDecoder().decode([LocalMessage].self, from: data) {
            messages = value
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(messages) else { return }
        try? data.write(to: historyURL, options: [.atomic, .completeFileProtection])
    }

    func clear() {
        task?.cancel()
        messages = []
        persist()
    }

    // MARK: turn

    func send(_ text: String) {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !busy, ready else { return }
        error = nil
        messages.append(LocalMessage(role: .user, text: prompt))
        persist()
        busy = true
        task = Task { [weak self] in
            await self?.run()
            self?.busy = false
        }
    }

    func stop() {
        task?.cancel()
        busy = false
    }

    private func run() async {
        // The loop is bounded so a model that keeps asking for tools cannot spin forever.
        for _ in 0..<8 {
            if Task.isCancelled { return }
            do {
                let reply = try await complete()
                if let call = reply.tool { try await perform(call) }
                else {
                    messages.append(LocalMessage(role: .assistant, text: reply.text))
                    persist()
                    return
                }
            } catch {
                self.error = message(error)
                return
            }
        }
        messages.append(LocalMessage(role: .assistant, text: "（工具调用次数达到上限，先停在这里）"))
        persist()
    }

    private struct ToolCall { let id: String; let name: String; let arguments: String }
    private struct Reply { let text: String; let tool: ToolCall? }

    private func complete() async throws -> Reply {
        var request = URLRequest(url: try endpoint())
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(provider.apiKey)", forHTTPHeaderField: "authorization")
        request.timeoutInterval = 120
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": provider.model,
            "messages": wireMessages(),
            "tools": Self.tools,
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw LocalAgentError.badResponse }
        guard (200..<300).contains(status) else {
            throw LocalAgentError.provider(status, String(decoding: data.prefix(400), as: UTF8.self))
        }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = root["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any]
        else { throw LocalAgentError.badResponse }
        let text = message["content"] as? String ?? ""
        let calls = message["tool_calls"] as? [[String: Any]]
        if let call = calls?.first,
           let id = call["id"] as? String,
           let function = call["function"] as? [String: Any],
           let name = function["name"] as? String {
            return Reply(text: text, tool: ToolCall(id: id, name: name,
                                                    arguments: function["arguments"] as? String ?? "{}"))
        }
        return Reply(text: text.isEmpty ? "（模型没有返回内容）" : text, tool: nil)
    }

    private func endpoint() throws -> URL {
        let trimmed = provider.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var url = URL(string: trimmed) else { throw LocalAgentError.badEndpoint }
        if !url.path.hasSuffix("/chat/completions") { url.appendPathComponent("chat/completions") }
        return url
    }

    private func wireMessages() -> [[String: Any]] {
        var wire: [[String: Any]] = [[
            "role": "system",
            "content": """
            You are miao running inside the user's phone. You can read, list and write files in your \
            workspace and fetch a URL. Paths are relative to the workspace. Be concise. When you change \
            a file, say which file you changed.
            """,
        ]]
        for message in messages {
            switch message.role {
            case .user: wire.append(["role": "user", "content": message.text])
            case .assistant: wire.append(["role": "assistant", "content": message.text])
            case .tool:
                wire.append(["role": "user", "content": "[\(message.toolName ?? "tool")] \(message.text)"])
            }
        }
        return wire
    }

    // MARK: tools

    private static let tools: [[String: Any]] = [
        tool("list_files", "List files under a workspace directory", ["path": "string"]),
        tool("read_file", "Read a UTF-8 text file from the workspace", ["path": "string"]),
        tool("write_file", "Write a UTF-8 text file in the workspace", ["path": "string", "content": "string"]),
        tool("fetch_url", "Fetch an HTTP(S) URL and return its text", ["url": "string"]),
    ]

    private static func tool(_ name: String, _ description: String, _ properties: [String: String]) -> [String: Any] {
        [
            "type": "function",
            "function": [
                "name": name,
                "description": description,
                "parameters": [
                    "type": "object",
                    "properties": properties.mapValues { ["type": $0] },
                    "required": Array(properties.keys),
                ],
            ],
        ]
    }

    private func perform(_ call: ToolCall) async throws {
        let arguments = (try? JSONSerialization.jsonObject(with: Data(call.arguments.utf8))) as? [String: Any] ?? [:]
        messages.append(LocalMessage(role: .tool, text: "调用 \(call.name)", toolName: call.name))
        persist()
        let result: String
        do {
            switch call.name {
            case "list_files": result = try list(arguments["path"] as? String ?? ".")
            case "read_file": result = try read(arguments["path"] as? String ?? "")
            case "write_file": result = try write(arguments["path"] as? String ?? "",
                                                  arguments["content"] as? String ?? "")
            case "fetch_url": result = try await fetch(arguments["url"] as? String ?? "")
            default: result = "未知工具：\(call.name)"
            }
        } catch {
            result = "失败：\(message(error))"
        }
        messages.append(LocalMessage(role: .tool, text: result, toolName: call.name))
        persist()
    }

    private func resolve(_ path: String) throws -> URL {
        let candidate = path.isEmpty ? workspace : workspace.appendingPathComponent(path)
        // Symlinks and `..` must not escape the workspace.
        let base = workspace.standardizedFileURL.path
        let target = candidate.standardizedFileURL.path
        guard target == base || target.hasPrefix(base + "/") else { throw LocalAgentError.outsideWorkspace }
        return URL(fileURLWithPath: target)
    }

    private func list(_ path: String) throws -> String {
        let url = try resolve(path)
        let entries = try FileManager.default.contentsOfDirectory(atPath: url.path).sorted()
        return entries.isEmpty ? "（空目录）" : entries.joined(separator: "\n")
    }

    private func read(_ path: String) throws -> String {
        let data = try Data(contentsOf: try resolve(path))
        let text = String(decoding: data.prefix(200_000), as: UTF8.self)
        return text.isEmpty ? "（空文件）" : text
    }

    private func write(_ path: String, _ content: String) throws -> String {
        let url = try resolve(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(content.utf8).write(to: url, options: [.atomic, .completeFileProtection])
        return "已写入 \(url.lastPathComponent)（\(content.utf8.count) 字节）"
    }

    private func fetch(_ value: String) async throws -> String {
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { throw LocalAgentError.badEndpoint }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return "HTTP \(status)\n\(String(decoding: data.prefix(20_000), as: UTF8.self))"
    }

    private func message(_ error: Error) -> String {
        if let value = error as? LocalAgentError { return value.text }
        return error.localizedDescription
    }
}

enum LocalAgentError: Error {
    case badEndpoint, badResponse, outsideWorkspace
    case provider(Int, String)

    var text: String {
        switch self {
        case .badEndpoint: return "接口地址无效"
        case .badResponse: return "模型返回了无法解析的内容"
        case .outsideWorkspace: return "路径超出了本机工作区"
        case .provider(let status, let body): return "服务商返回 \(status)：\(body)"
        }
    }
}
