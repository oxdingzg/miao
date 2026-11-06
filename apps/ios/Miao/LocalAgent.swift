import Foundation
import MCP
import UIKit
import Observation

/// On-device assistant: it talks to a provider the owner configured on the phone
/// and runs its tools against the app's own sandbox. Nothing here needs a
/// computer, an account, or the relay.
struct LocalProvider: Codable, Sendable, Equatable, Identifiable {
    var id = UUID()
    var name: String = ""
    var baseURL: String = ""
    var apiKey: String = ""
    var model: String = ""
}

struct LocalMessage: Codable, Sendable, Equatable, Identifiable {
    enum Role: String, Codable, Sendable { case user, assistant, tool }
    var id = UUID()
    var role: Role
    var text: String
    var toolName: String?
    /// Base64 JPEG, downscaled before it is stored, for multimodal turns.
    var images: [String] = []
}

struct LocalSession: Codable, Sendable, Equatable, Identifiable {
    var id = UUID()
    var title = ""
    var messages: [LocalMessage] = []
    var updated = Date()
}

@MainActor @Observable
final class LocalAgent {
    private(set) var providers: [LocalProvider] = []
    /// Optional MCP server reachable over HTTP; stdio is unavailable on iOS.
    private(set) var mcpURL: String?
    var mcpError: String?
    private var mcpClient: Client?
    private var mcpTools: [Tool] = []
    private(set) var selectedID: UUID?
    private(set) var sessions: [LocalSession] = []
    private(set) var currentID: UUID?

    /// Transcript of the selected Session; mutating it keeps the Session's
    /// ordering and its derived title in step.
    var messages: [LocalMessage] {
        get { sessions.first { $0.id == currentID }?.messages ?? [] }
        set {
            guard let index = sessions.firstIndex(where: { $0.id == currentID }) else { return }
            sessions[index].messages = newValue
            sessions[index].updated = Date()
            if sessions[index].title.isEmpty, let first = newValue.first(where: { $0.role == .user }) {
                sessions[index].title = String(first.text.prefix(30))
            }
        }
    }
    private(set) var busy = false
    var error: String?

    /// The provider the next turn uses. Kept as a value so a partially filled
    /// row in the editor never becomes the active one by accident.
    var provider: LocalProvider {
        providers.first { $0.id == selectedID } ?? LocalProvider()
    }

    /// Every tool resolves inside this directory, so a path from the model can
    /// never escape the app's own storage.
    let workspace: URL
    private var task: Task<Void, Never>?

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        workspace = support.appendingPathComponent("LocalAgent/workspace", isDirectory: true)
        try? FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        load()
        importFromEnvironment()
    }

    var ready: Bool { !provider.model.isEmpty && !provider.apiKey.isEmpty && !provider.baseURL.isEmpty }

    // MARK: persistence

    private struct Stored: Codable { var providers: [LocalProvider]; var selected: UUID?; var mcp: String? }

    private var configURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LocalAgent/config.json")
    }
    private var historyURL: URL { configURL.deletingLastPathComponent().appendingPathComponent("sessions.json") }
    private var legacyHistoryURL: URL { configURL.deletingLastPathComponent().appendingPathComponent("history.json") }

    func save(_ next: LocalProvider) {
        if let index = providers.firstIndex(where: { $0.id == next.id }) { providers[index] = next }
        else { providers.append(next) }
        if selectedID == nil { selectedID = next.id }
        store()
    }

    func select(_ id: UUID?) {
        selectedID = id
        store()
    }

    func setMCP(_ raw: String) async {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        mcpURL = trimmed.isEmpty ? nil : trimmed
        mcpClient = nil
        mcpTools = []
        store()
        await refreshMCP()
    }

    func refreshMCP() async {
        guard let raw = mcpURL, let url = URL(string: raw) else { return }
        mcpError = nil
        do {
            let client = Client(name: "miao-local", version: "1")
            _ = try await client.connect(transport: HTTPClientTransport(endpoint: url))
            mcpTools = try await client.listTools().tools
            mcpClient = client
        } catch {
            mcpTools = []
            mcpClient = nil
            mcpError = error.localizedDescription
        }
    }

    func remove(_ id: UUID) {
        providers.removeAll { $0.id == id }
        if selectedID == id { selectedID = providers.first?.id }
        store()
    }

    private func store() {
        guard let data = try? JSONEncoder().encode(Stored(providers: providers, selected: selectedID, mcp: mcpURL)) else { return }
        try? FileManager.default.createDirectory(at: configURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? data.write(to: configURL, options: [.atomic, .completeFileProtection])
    }

    /// One-shot import so a desktop can hand the phone its providers without the
    /// credentials ever entering the repository: launch with
    /// `MIAO_LOCAL_PROVIDERS=<base64 JSON array>`, then the variable is ignored.
    private func importFromEnvironment() {
        guard providers.isEmpty,
              let raw = ProcessInfo.processInfo.environment["MIAO_LOCAL_PROVIDERS"],
              let data = Data(base64Encoded: raw),
              let imported = try? JSONDecoder().decode([LocalProvider].self, from: data),
              !imported.isEmpty
        else { return }
        providers = imported
        selectedID = imported.first?.id
        store()
        print("miao-local-import:\(imported.count)")
    }

    private func load() {
        if let data = try? Data(contentsOf: configURL),
           let value = try? JSONDecoder().decode(Stored.self, from: data) {
            providers = value.providers
            selectedID = value.selected ?? value.providers.first?.id
            mcpURL = value.mcp
        }
        if let data = try? Data(contentsOf: historyURL),
           let value = try? JSONDecoder().decode([LocalSession].self, from: data) {
            sessions = value
        } else if let data = try? Data(contentsOf: legacyHistoryURL),
                  let value = try? JSONDecoder().decode([LocalMessage].self, from: data), !value.isEmpty {
            let title = String(value.first(where: { $0.role == .user })?.text.prefix(30) ?? "")
            sessions = [LocalSession(title: title, messages: value)]
            try? FileManager.default.removeItem(at: legacyHistoryURL)
            persist()
        }
        currentID = sessions.first?.id
        if sessions.isEmpty { newSession() }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(sessions) else { return }
        try? data.write(to: historyURL, options: [.atomic, .completeFileProtection])
    }

    func newSession() {
        stop()
        let session = LocalSession()
        sessions.insert(session, at: 0)
        currentID = session.id
        persist()
    }

    func selectSession(_ id: UUID) {
        guard sessions.contains(where: { $0.id == id }) else { return }
        stop()
        currentID = id
        persist()
    }

    func renameSession(_ id: UUID, title: String) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        sessions[index].title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        persist()
    }

    func deleteSession(_ id: UUID) {
        sessions.removeAll { $0.id == id }
        if currentID == id { currentID = sessions.first?.id }
        if sessions.isEmpty { newSession() }
        persist()
    }

    func clear() {
        stop()
        messages = []
        if let index = sessions.firstIndex(where: { $0.id == currentID }) { sessions[index].title = "" }
        persist()
    }

    // MARK: turn

    func send(_ text: String, images: [UIImage] = []) {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!prompt.isEmpty || !images.isEmpty), !busy, ready else { return }
        error = nil
        let encoded = images.prefix(4).compactMap(Self.jpeg)
        let title = prompt.isEmpty ? "（图片）" : prompt
        messages.append(LocalMessage(role: .user, text: prompt.isEmpty ? title : prompt, images: encoded))
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
                    // Streaming already grew the bubble; only a quiet reply needs one.
                    if !reply.streamed { messages.append(LocalMessage(role: .assistant, text: reply.text)) }
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
    private struct Reply { let text: String; let tool: ToolCall?; let streamed: Bool }

    /// Streams the provider response so text appears as it arrives, and folds
    /// tool-call deltas back into one call. `stream: true` is the only change to
    /// the request body; the wire format stays OpenAI's chat completions.
    private func complete() async throws -> Reply {
        var request = URLRequest(url: try endpoint())
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(provider.apiKey)", forHTTPHeaderField: "authorization")
        request.timeoutInterval = 120
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": provider.model,
            "messages": wireMessages(),
            "tools": toolDefinitions(),
            "stream": true,
        ])
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw LocalAgentError.badResponse }
        guard (200..<300).contains(status) else {
            let body = try await bytes.reduce(into: Data()) { $0.append($1) }
            throw LocalAgentError.provider(status, String(decoding: body.prefix(400), as: UTF8.self))
        }

        var text = ""
        var callID: String?
        var callName: String?
        var callArguments = ""
        var streamed = false

        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
                  let choices = object["choices"] as? [[String: Any]],
                  let first = choices.first,
                  let delta = first["delta"] as? [String: Any]
            else { continue }

            if let piece = delta["content"] as? String, !piece.isEmpty {
                text += piece
                if streamed { messages[messages.count - 1].text = text }
                else { messages.append(LocalMessage(role: .assistant, text: text)); streamed = true }
            }
            if let calls = delta["tool_calls"] as? [[String: Any]], let call = calls.first {
                if let id = call["id"] as? String { callID = id }
                if let function = call["function"] as? [String: Any] {
                    if let name = function["name"] as? String { callName = name }
                    if let arguments = function["arguments"] as? String { callArguments += arguments }
                }
            }
            if Task.isCancelled { break }
        }

        if let name = callName, text.isEmpty, streamed {
            // A turn that only calls a tool must not leave an empty bubble behind.
            messages.removeLast()
            streamed = false
        }
        if let name = callName {
            return Reply(text: text, tool: ToolCall(id: callID ?? UUID().uuidString, name: name,
                                                    arguments: callArguments.isEmpty ? "{}" : callArguments),
                         streamed: streamed)
        }
        return Reply(text: text.isEmpty ? "（模型没有返回内容）" : text, tool: nil, streamed: streamed)
    }

    /// Phone photos are far larger than a model needs; shrink once, then keep
    /// the small copy so a Session file stays reasonable.
    static func jpeg(_ image: UIImage) -> String? {
        let maxEdge: CGFloat = 1024
        let scale = min(1, maxEdge / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        let small = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return small.jpegData(compressionQuality: 0.7)?.base64EncodedString()
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
            case .user:
                if message.images.isEmpty {
                    wire.append(["role": "user", "content": message.text])
                } else {
                    var parts: [[String: Any]] = [["type": "text", "text": message.text]]
                    for image in message.images {
                        parts.append(["type": "image_url",
                                      "image_url": ["url": "data:image/jpeg;base64,\(image)"]])
                    }
                    wire.append(["role": "user", "content": parts])
                }
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

    /// Built-in tools plus whatever the configured MCP server advertises.
    private func toolDefinitions() -> [[String: Any]] {
        Self.tools + mcpTools.compactMap { tool in
            guard let data = try? JSONEncoder().encode(tool.inputSchema),
                  let schema = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return nil }
            return ["type": "function",
                    "function": ["name": tool.name,
                                 "description": tool.description ?? "",
                                 "parameters": schema]]
        }
    }

    private func callMCP(_ call: ToolCall) async throws -> String {
        guard let client = mcpClient else { return "MCP 未连接" }
        let decoded = try? JSONDecoder().decode(Value.self, from: Data(call.arguments.utf8))
        guard case .object(let arguments)? = decoded else { throw LocalAgentError.badResponse }
        let (content, isError) = try await client.callTool(name: call.name, arguments: arguments)
        let text = content.compactMap { item -> String? in
            if case .text(let value, _, _) = item { return value }
            return nil
        }.joined(separator: "\n")
        if isError == true { return "失败：\(text)" }
        return text.isEmpty ? "（无文本返回）" : text
    }

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
            if mcpTools.contains(where: { $0.name == call.name }) {
                result = try await callMCP(call)
            } else {
                switch call.name {
                case "list_files": result = try list(arguments["path"] as? String ?? ".")
                case "read_file": result = try read(arguments["path"] as? String ?? "")
                case "write_file": result = try write(arguments["path"] as? String ?? "",
                                                      arguments["content"] as? String ?? "")
                case "fetch_url": result = try await fetch(arguments["url"] as? String ?? "")
                default: result = "未知工具：\(call.name)"
                }
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
