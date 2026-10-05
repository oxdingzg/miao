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
                            session: URLSession = .shared, allowLoopbackHTTP: Bool = false, account: HubAccount? = nil,
                            reconcile: @escaping Reconcile) async throws -> HubConnection {
        guard host.grantVersion > 0 else { throw RemoteRPCError.invalidEndpoint }
        let selected: ApprovedHost
        do { selected = try await account?.refreshedHost(host) ?? host }
        catch HubAccountError.authenticationRequired { throw RemoteConnectionError.authorizationBlocked }
        catch HubAccountError.rejected(let status) where status == 401 || status == 403 {
            throw RemoteConnectionError.authorizationBlocked
        }
        let host = selected
        let socket: URLSessionWebSocketTask
        if let account { socket = try await authorizedSocket(account: account, hubURL: host.hubURL, hostID: host.target.hostID) }
        else { socket = try session.webSocketTask(with: endpoint(hubURL: host.hubURL, hostID: host.target.hostID,
                                                               allowLoopbackHTTP: allowLoopbackHTTP)) }
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
            if error is ChannelError || socket.closeCode == .policyViolation
                || [401, 403].contains((socket.response as? HTTPURLResponse)?.statusCode ?? 0) {
                throw RemoteConnectionError.authorizationBlocked
            }
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

extension HubConnection {
    private static func authorizedSocket(account: HubAccount, hubURL: URL, hostID: String) async throws -> URLSessionWebSocketTask {
        do { return try await account.relaySocket(hubURL: hubURL, hostID: hostID) }
        catch HubAccountError.authenticationRequired { throw RemoteConnectionError.authorizationBlocked }
        catch HubAccountError.rejected(let status) where status == 401 || status == 403 {
            throw RemoteConnectionError.authorizationBlocked
        }
    }

    static func endpoint(hubURL: URL?, hostID: String, allowLoopbackHTTP: Bool) throws -> URL {
        guard let hubURL, var url = URLComponents(url: hubURL, resolvingAgainstBaseURL: false),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              !(url.host ?? "").isEmpty, url.path.isEmpty || url.path == "/" else {
            throw RemoteRPCError.invalidEndpoint
        }
        let local = allowLoopbackHTTP && url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? "")
        guard url.scheme == "https" || local else { throw RemoteRPCError.invalidEndpoint }
        url.scheme = local ? "ws" : "wss"
        url.path = "/v1/client"
        url.queryItems = [URLQueryItem(name: "hostID", value: hostID)]
        guard let endpoint = url.url else { throw RemoteRPCError.invalidEndpoint }
        return endpoint
    }

    /// No RPC reader starts until local owner approval is verified and the caller durably saves it.
    /// A lost approval is uncertain, never an excuse to assume a grant or repeat a business operation.
    public static func pair(invitation: PairingInvitation, identity: P256.Signing.PrivateKey, label: String,
                            session: URLSession = .shared, allowLoopbackHTTP: Bool = false, account: HubAccount? = nil,
                            pending: @escaping @Sendable (String) async -> Void,
                            persist: @escaping @Sendable (ApprovedHost, DeviceGrant) async throws -> Void,
                            reconcile: @escaping Reconcile) async throws -> PairedConnection {
        try invitation.validate(allowLoopbackHTTP: allowLoopbackHTTP)
        let socket: URLSessionWebSocketTask
        if let account, let hubURL = URL(string: invitation.hubURL) {
            socket = try await authorizedSocket(account: account, hubURL: hubURL, hostID: invitation.hostID)
        } else {
            socket = try session.webSocketTask(with: endpoint(hubURL: URL(string: invitation.hubURL), hostID: invitation.hostID,
                                                            allowLoopbackHTTP: allowLoopbackHTTP))
        }
        socket.maximumMessageSize = 256 * 1024
        socket.resume()
        let seconds = min(180, max(0, Double(invitation.expiresAt) / 1000 - Date().timeIntervalSince1970))
        let deadline = Task {
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            socket.cancel(with: .goingAway, reason: nil)
        }
        defer { deadline.cancel() }
        var provisional = false
        do {
            return try await withTaskCancellationHandler {
                let handshake = try ClientHandshake(identity: identity, target: invitation.target)
                let hello = handshake.hello
                try await socket.send(.string(try invitation.claim(label: label, hello: hello).base64URL))
                let message = try await socket.receive()
                guard case .string(let value) = message, value.utf8.count <= 8192 else { throw RemoteRPCError.malformed }
                let reply = try JSONDecoder().decode(ServerHello.self, from: decodeBase64URL(value))
                let channel = try await handshake.finish(reply, trustedHostKey: invitation.hostPublicKey)
                var assembler = ResponseAssembler(allowedTypes: ["pairing"])
                while true {
                    try Task.checkCancellation()
                    let message = try await socket.receive()
                    guard case .string(let packet) = message else { throw RemoteRPCError.malformed }
                    guard let plaintext = try assembler.append(await channel.open(packet)) else { continue }
                    let notice = try JSONDecoder().decode(PairingNotification.self, from: plaintext)
                    guard notice.version == 1, notice.type == "pairing" else { throw RemoteRPCError.malformed }
                    if !provisional {
                        guard notice.status == "pending", notice.pairingID == invitation.pairingID, notice.grant == nil else {
                            throw RemoteRPCError.malformed
                        }
                        provisional = true
                        await pending(DeviceFingerprint.of(identity.publicKey))
                        continue
                    }
                    guard notice.status == "approved", let grant = notice.grant else { throw RemoteRPCError.malformed }
                    try grant.validate(deviceKey: identity.publicKey.x963Representation.base64URL)
                    let host = ApprovedHost(label: invitation.hostID, hubURL: URL(string: invitation.hubURL)!,
                                            target: invitation.target, publicKey: invitation.hostPublicKey,
                                            grantID: grant.id, grantVersion: grant.version)
                    try await persist(host, grant)
                    try Task.checkCancellation()
                    let connected = HubConnection(host: host, socket: socket, channel: channel, reconcile: reconcile)
                    await connected.startReader()
                    return PairedConnection(host: host, grant: grant, connection: connected)
                }
            } onCancel: { socket.cancel(with: .goingAway, reason: nil) }
        } catch {
            socket.cancel(with: .goingAway, reason: nil)
            if Task.isCancelled { throw CancellationError() }
            if error is ChannelError || socket.closeCode == .policyViolation
                || [401, 403].contains((socket.response as? HTTPURLResponse)?.statusCode ?? 0) {
                throw RemoteConnectionError.authorizationBlocked
            }
            if provisional { throw PairingError.approvalUncertain }
            throw error
        }
    }
}
