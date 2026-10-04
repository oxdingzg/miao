import Foundation
import CryptoKit

/// Transport never retries an operation, interrupts a session or decides its outcome.
public actor HubConnection: ClientConnection {
    public typealias Reconcile = @Sendable (HubConnection) async throws -> Void
    private struct Pending {
        let continuation: CheckedContinuation<JSONValue, Error>
        let timeout: Task<Void, Never>
    }
    private let host: ApprovedHost
    private let socket: URLSessionWebSocketTask
    private let channel: SecureSession
    private let reconcile: Reconcile
    private var pending: [String: Pending] = [:]
    private var reader: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var assembler = ResponseAssembler()
    private var stopped = false
    private var disconnectError: Error = RemoteRPCError.disconnected
    private var disconnectWaiters: [CheckedContinuation<Void, Error>] = []

    private init(host: ApprovedHost, socket: URLSessionWebSocketTask, channel: SecureSession,
                 reconcile: @escaping Reconcile) {
        self.host = host
        self.socket = socket
        self.channel = channel
        self.reconcile = reconcile
    }

    public static func open(host: ApprovedHost, identity: P256.Signing.PrivateKey,
                            session: URLSession = .shared, allowLoopbackHTTP: Bool = false,
                            reconcile: @escaping Reconcile) async throws -> HubConnection {
        guard var url = URLComponents(url: host.hubURL, resolvingAgainstBaseURL: false),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              !(url.host ?? "").isEmpty,
              url.path.isEmpty || url.path == "/", host.grantVersion > 0 else { throw RemoteRPCError.invalidEndpoint }
        let local = allowLoopbackHTTP && url.scheme == "http" && ["127.0.0.1", "::1", "[::1]"].contains(url.host ?? "")
        guard url.scheme == "https" || local else { throw RemoteRPCError.invalidEndpoint }
        url.scheme = local ? "ws" : "wss"
        url.path = "/v1/client"
        url.queryItems = [URLQueryItem(name: "hostID", value: host.target.hostID)]
        guard let endpoint = url.url else { throw RemoteRPCError.invalidEndpoint }
        let socket = session.webSocketTask(with: endpoint)
        socket.maximumMessageSize = 256 * 1024
        socket.resume()
        let deadline = Task {
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            socket.cancel(with: .goingAway, reason: nil)
        }
        defer { deadline.cancel() }
        do {
            return try await withTaskCancellationHandler {
                let handshake = try ClientHandshake(identity: identity, target: host.target)
                let hello = try JSONEncoder().encode(handshake.hello)
                try await socket.send(.string(hello.base64URL))
                let message = try await socket.receive()
                guard case .string(let value) = message, value.utf8.count <= 8192 else { throw RemoteRPCError.malformed }
                let reply = try JSONDecoder().decode(ServerHello.self, from: decodeBase64URL(value))
                let channel = try await handshake.finish(reply, trustedHostKey: host.publicKey)
                try Task.checkCancellation()
                let connected = HubConnection(host: host, socket: socket, channel: channel, reconcile: reconcile)
                await connected.startReader()
                return connected
            } onCancel: { socket.cancel(with: .goingAway, reason: nil) }
        } catch {
            socket.cancel(with: .goingAway, reason: nil)
            if error is ChannelError { throw RemoteConnectionError.authorizationBlocked }
            throw error
        }
    }

    public func synchronize() async throws {
        _ = try await request(.capabilities)
        try await reconcile(self)
    }

    public func request(_ method: RemoteMethod, sessionID: String? = nil, projectID: String? = nil,
                        operationID: UUID? = nil, payload: JSONValue = .object([:])) async throws -> JSONValue {
        guard !stopped else { throw RemoteRPCError.disconnected }
        guard pending.count < 8 else { throw RemoteRPCError.overloaded }
        let id = UUID().uuidString.lowercased()
        let request = RemoteRequest(requestID: id, hostID: host.target.hostID, runtimeID: host.target.runtimeID,
                                    grantID: host.grantID, grantVersion: host.grantVersion, method: method,
                                    sessionID: sessionID, projectID: projectID,
                                    operationID: operationID?.uuidString.lowercased(), payload: payload)
        let bytes = try JSONEncoder().encode(request)
        guard bytes.count <= 128 * 1024 else { throw RemoteRPCError.overloaded }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let timeout = Task {
                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                    cancel(id, error: RemoteRPCError.timeout)
                }
                pending[id] = Pending(continuation: continuation, timeout: timeout)
                let previous = sender
                // Serializing seal+send together preserves channel sequence order
                // across actor reentrancy and URLSession backpressure.
                sender = Task {
                    await previous?.value
                    guard !stopped, pending[id] != nil else { return }
                    do {
                        let sealed = try await channel.seal(bytes)
                        try await socket.send(.string(sealed))
                    } catch { await close() }
                }
            }
        } onCancel: {
            Task { await self.cancel(id, error: RemoteRPCError.cancelled) }
        }
    }

    public func close() async {
        guard !stopped else { return }
        stopped = true
        reader?.cancel()
        sender?.cancel()
        socket.cancel(with: .goingAway, reason: nil)
        disconnectWaiters.forEach { $0.resume(throwing: disconnectError) }
        disconnectWaiters.removeAll()
        let requests = pending
        pending.removeAll()
        requests.values.forEach {
            $0.timeout.cancel()
            $0.continuation.resume(throwing: RemoteRPCError.disconnected)
        }
    }

    public func waitForDisconnect() async throws {
        if stopped { throw disconnectError }
        try await withCheckedThrowingContinuation { disconnectWaiters.append($0) }
    }

    private func startReader() {
        reader = Task {
            do {
                while !stopped {
                    let message = try await socket.receive()
                    guard case .string(let value) = message else { throw RemoteRPCError.malformed }
                    let plaintext = try await channel.open(value)
                    guard !stopped, let complete = try assembler.append(plaintext) else { continue }
                    let response = try JSONDecoder().decode(RemoteResponse.self, from: complete)
                    guard response.version == 1, UUID(uuidString: response.requestID) != nil else { throw RemoteRPCError.malformed }
                    guard let request = pending.removeValue(forKey: response.requestID) else { continue }
                    request.timeout.cancel()
                    if response.type == "result", let data = response.data {
                        request.continuation.resume(returning: data)
                    } else if response.type == "error", let code = response.code {
                        request.continuation.resume(throwing: RemoteRPCError.rejected(code))
                    } else {
                        request.continuation.resume(throwing: RemoteRPCError.malformed)
                        throw RemoteRPCError.malformed
                    }
                }
            } catch {
                if socket.closeCode == .policyViolation { disconnectError = RemoteConnectionError.authorizationBlocked }
                if error as? RemoteRPCError == .malformed { disconnectError = RemoteConnectionError.protocolIncompatible }
                await close()
            }
        }
    }

    private func cancel(_ id: String, error: Error) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.timeout.cancel()
        request.continuation.resume(throwing: error)
    }
}
