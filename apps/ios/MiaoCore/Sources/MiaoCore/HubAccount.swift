import Foundation
import Security
import CryptoKit

public enum HubAccountError: Error, Equatable {
    case invalidEndpoint, invalidCredentials, authenticationRequired, rejected(Int), malformed, superseded
    case storage(Int32)
}

public struct HubDirectoryHost: Decodable, Sendable, Equatable, Identifiable {
    public let hostID: String
    public let name: String
    public let publicKey: String
    public let createdAt: Int64
    public let revokedAt: Int64?
    public let online: Bool
    public let runtimeID: String?
    public var id: String { hostID + ":" + (runtimeID ?? "offline") }
}

private final class HubAccountRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Never forward an account password or bearer credential to another URL.
        completionHandler(nil)
    }
}

/// Account credentials authorize the opaque relay; the Agent's device grant still authorizes every RPC.
public actor HubAccount {
    public let origin: URL
    private let session: URLSession
    private let relaySession: URLSession
    private let keychainService: String
    private var login: String?
    private var pendingLogout: String?
    private var access: (value: String, until: Date)?
    private var generation: UInt64 = 0
    private var relaySockets: [URLSessionWebSocketTask] = []

    public init(origin: URL, keychainService: String = "miao.remote.hub-account",
                allowLoopbackHTTP: Bool = false) throws {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, components.path.isEmpty || components.path == "/",
              let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(), !host.isEmpty,
              components.port == nil || (1...65535).contains(components.port!),
              scheme == "https" || (allowLoopbackHTTP && scheme == "http"
                && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
            throw HubAccountError.invalidEndpoint
        }
        components.scheme = scheme
        components.host = host
        components.path = ""
        if (scheme == "https" && components.port == 443)
            || (scheme == "http" && components.port == 80) { components.port = nil }
        guard let normalized = components.url else { throw HubAccountError.invalidEndpoint }
        self.origin = normalized
        self.keychainService = keychainService
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        self.session = URLSession(configuration: configuration, delegate: HubAccountRedirects(), delegateQueue: nil)
        let relayConfiguration = URLSessionConfiguration.ephemeral
        relayConfiguration.httpShouldSetCookies = false
        relayConfiguration.httpCookieStorage = nil
        relayConfiguration.urlCache = nil
        relayConfiguration.timeoutIntervalForRequest = 15
        // The HTTP account resource deadline must not terminate a foreground relay after twenty seconds.
        relayConfiguration.timeoutIntervalForResource = 7 * 24 * 60 * 60
        self.relaySession = URLSession(configuration: relayConfiguration, delegate: HubAccountRedirects(), delegateQueue: nil)
    }

    public func restore() throws -> Bool {
        guard login == nil else { return true }
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess else { throw HubAccountError.storage(status) }
        guard let data = item as? Data, let credential = String(data: data, encoding: .utf8),
              Self.validCredential(credential) else { throw HubAccountError.malformed }
        login = credential
        generation &+= 1
        return true
    }

    public func signIn(email: String, password: String) async throws {
        guard !email.isEmpty, email.utf8.count <= 320, !password.isEmpty, password.utf8.count <= 1024 else {
            throw HubAccountError.invalidCredentials
        }
        if pendingLogout != nil { try await signOut() }
        generation &+= 1
        let expected = generation
        let body = try JSONEncoder().encode(SignIn(email: email, password: password))
        let (_, response) = try await send("/api/auth/sign-in/email", body: body)
        guard let credential = response.value(forHTTPHeaderField: "set-auth-token"),
              Self.validCredential(credential) else { throw HubAccountError.malformed }
        guard generation == expected else {
            _ = try? await send("/api/auth/sign-out", credential: credential, body: Data("{}".utf8))
            throw HubAccountError.superseded
        }
        do { try save(credential) }
        catch {
            _ = try? await send("/api/auth/sign-out", credential: credential, body: Data("{}".utf8))
            throw error
        }
        login = credential
        access = nil
    }

    /// Ask the hub for the provider's authorize URL. The caller presents it and
    /// returns the one-time code from the app's callback scheme.
    public func oauthAuthorizeURL(provider: String, callbackURL: String) async throws -> URL {
        guard provider == "github" || provider == "google",
              let callback = URL(string: callbackURL), callback.scheme != nil else {
            throw HubAccountError.invalidEndpoint
        }
        let body = try JSONEncoder().encode(SocialSignIn(provider: provider, callbackURL: callbackURL))
        let (data, _) = try await send("/api/auth/sign-in/social", body: body)
        let start = try JSONDecoder().decode(SocialStart.self, from: data)
        guard let url = URL(string: start.url), url.scheme?.lowercased() == "https" else {
            throw HubAccountError.malformed
        }
        return url
    }

    /// Trade the provider's one-time code for an access token and sign in. mhub
    /// has no password, so this is the only way in for an OAuth-only hub.
    public func signInWithOAuth(code: String) async throws {
        guard !code.isEmpty, code.utf8.count <= 512 else { throw HubAccountError.malformed }
        if pendingLogout != nil { try await signOut() }
        generation &+= 1
        let expected = generation
        let body = try JSONEncoder().encode(Exchange(code: code, client: "ios"))
        let (data, _) = try await send("/api/auth/exchange", body: body)
        let token = try JSONDecoder().decode(ExchangeResult.self, from: data).token
        guard generation == expected else { throw HubAccountError.superseded }
        guard Self.validCredential(token) else { throw HubAccountError.malformed }
        try save(token)
        login = token
        access = (token, Date().addingTimeInterval(600))
    }

    public func bearer() async throws -> String {
        if let access, access.until > Date() { return access.value }
        guard let credential = login else { throw HubAccountError.authenticationRequired }
        let expected = generation
        do {
            let (data, _) = try await send("/api/auth/token", credential: credential)
            let token = try JSONDecoder().decode(Token.self, from: data).token
            guard generation == expected, login == credential else { throw HubAccountError.superseded }
            guard Self.validCredential(token), token.split(separator: ".").count == 3 else {
                throw HubAccountError.malformed
            }
            // Refresh before the server's fifteen-minute expiry; only the signed login session is persisted.
            access = (token, Date().addingTimeInterval(600))
            // An OAuth sign-in stores the access token itself as the credential,
            // so a rotated token must replace it or the next refresh uses a dead one.
            if login == credential, credential.split(separator: ".").count == 3 {
                login = token
                try? save(token)
            }
            return token
        } catch HubAccountError.authenticationRequired {
            if generation == expected { try clear() }
            throw HubAccountError.authenticationRequired
        }
    }

    public func hosts() async throws -> [HubDirectoryHost] {
        let expected = generation
        let token = try await bearer()
        let (data, _) = try await send("/api/hub/hosts", credential: token)
        guard generation == expected else { throw HubAccountError.superseded }
        let hosts = try JSONDecoder().decode(Directory.self, from: data).data
        guard hosts.count <= 64, Set(hosts.map(\.id)).count == hosts.count,
              hosts.allSatisfy({ $0.hostID.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil
                && !$0.name.isEmpty && $0.name.utf8.count <= 512
                && $0.publicKey.utf8.count <= 128
                && (!$0.online || $0.runtimeID != nil) }) else { throw HubAccountError.malformed }
        for host in hosts {
            guard let key = try? decodeBase64URL(host.publicKey), key.count == 65,
                  (try? P256.Signing.PublicKey(x963Representation: key)) != nil else {
                throw HubAccountError.malformed
            }
            if let runtimeID = host.runtimeID {
                do { try RemoteTarget(hostID: host.hostID, runtimeID: runtimeID).validate() }
                catch { throw HubAccountError.malformed }
            }
        }
        return hosts
    }

    public func pushRegistrationAvailable(requireDelivery: Bool = false) async throws -> Bool {
        let expected = generation
        let token = try await bearer()
        let (data, _) = try await send("/api/hub/version", credential: token)
        guard generation == expected else { throw HubAccountError.superseded }
        let version = try JSONDecoder().decode(HubVersion.self, from: data)
        guard version.protocolVersion == 1, version.capabilities.count <= 32,
              version.capabilities.allSatisfy({ $0.utf8.count <= 128 }) else { throw HubAccountError.malformed }
        return version.capabilities.contains("push-registration") &&
            (!requireDelivery || version.capabilities.contains("push-delivery"))
    }

    public func registerPush(_ registration: PushDeviceRegistration) async throws -> HubPushRegistration {
        let expected = generation
        let token = try await bearer()
        let body = try JSONEncoder().encode(registration)
        let (data, _) = try await send("/api/hub/push/register", credential: token, body: body)
        guard generation == expected else { throw HubAccountError.superseded }
        let result = try JSONDecoder().decode(HubPushRegistration.self, from: data)
        guard result.registeredAt >= 0, UUID(uuidString: result.registrationID) != nil else {
            throw HubAccountError.malformed
        }
        return result
    }

    public func pushContext(deviceID: String, signalID: String) async throws -> HubPushNotice {
        guard deviceID.range(of: "^[A-Za-z0-9_-]{87}$", options: .regularExpression) != nil,
              signalID.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil else {
            throw HubAccountError.malformed
        }
        let expected = generation
        let token = try await bearer()
        let (data, _) = try await send("/api/hub/push/context", credential: token,
            query: [URLQueryItem(name: "deviceID", value: deviceID), URLQueryItem(name: "signalID", value: signalID)])
        guard generation == expected else { throw HubAccountError.superseded }
        guard data.count <= 8192 else { throw HubAccountError.malformed }
        let notice = try JSONDecoder().decode(HubPushNotice.self, from: data)
        guard notice.binding.deviceID == deviceID, notice.binding.signalID == signalID else {
            throw HubAccountError.malformed
        }
        return notice
    }

    public func revokePush(deviceID: String) async throws {
        guard let key = try? decodeBase64URL(deviceID), key.count == 65, key.base64URL == deviceID,
              (try? P256.Signing.PublicKey(x963Representation: key)) != nil else { throw HubAccountError.malformed }
        let expected = generation
        let token = try await bearer()
        let body = try JSONEncoder().encode(PushRevocation(deviceID: deviceID))
        let (data, _) = try await send("/api/hub/push/revoke", credential: token, body: body)
        guard generation == expected else { throw HubAccountError.superseded }
        guard try JSONDecoder().decode(PushRevoked.self, from: data).revoked else { throw HubAccountError.malformed }
    }

    public func signOut() async throws {
        let credential = login ?? pendingLogout
        try clear()
        pendingLogout = credential
        guard let credential else { return }
        // Local sign-out is immediate even when the network is unavailable; report failure to revoke remotely.
        do { _ = try await send("/api/auth/sign-out", credential: credential, body: Data("{}".utf8)) }
        catch HubAccountError.authenticationRequired {
            // An already expired/revoked session has no remaining server authority.
        }
        if pendingLogout == credential { pendingLogout = nil }
    }

    public func close() {
        generation &+= 1
        login = nil
        pendingLogout = nil
        access = nil
        relaySockets.forEach { $0.cancel(with: .policyViolation, reason: nil) }
        relaySockets.removeAll()
        session.invalidateAndCancel()
        relaySession.invalidateAndCancel()
    }

    /// Directory discovery can update an execution instance, never the locally pinned host identity or device grant.
    func refreshedHost(_ host: ApprovedHost) async throws -> ApprovedHost {
        _ = try relayRequest(hubURL: host.hubURL, hostID: host.target.hostID, token: "validation")
        let directory = try await hosts()
        guard let current = directory.first(where: { $0.hostID == host.target.hostID && $0.runtimeID == host.target.runtimeID }), current.revokedAt == nil,
              current.publicKey == host.publicKey else { throw RemoteConnectionError.authorizationBlocked }
        guard current.online, let runtimeID = current.runtimeID else { throw RemoteRPCError.disconnected }
        return ApprovedHost(id: host.id, label: host.label, hubURL: host.hubURL,
                            target: RemoteTarget(hostID: host.target.hostID, runtimeID: runtimeID),
                            publicKey: host.publicKey, grantID: host.grantID, grantVersion: host.grantVersion)
    }

    /// The account owns the redirect-rejecting session so relay credentials cannot escape its origin.
    func relaySocket(hubURL: URL, hostID: String, runtimeID: String) async throws -> URLSessionWebSocketTask {
        // Validate before requesting a token, then fence sign-out during the token request.
        _ = try relayRequest(hubURL: hubURL, hostID: hostID, runtimeID: runtimeID, token: "validation")
        let expected = generation
        let token = try await bearer()
        guard expected == generation, login != nil else { throw HubAccountError.superseded }
        relaySockets.removeAll { $0.state == .completed || $0.state == .canceling }
        guard relaySockets.count < 64 else { throw RemoteRPCError.overloaded }
        let socket = relaySession.webSocketTask(with: try relayRequest(hubURL: hubURL, hostID: hostID, runtimeID: runtimeID, token: token))
        relaySockets.append(socket)
        return socket
    }

    func relayRequest(hubURL: URL, hostID: String, runtimeID: String? = nil, token: String) throws -> URLRequest {
        guard let supplied = URLComponents(url: hubURL, resolvingAgainstBaseURL: false),
              let canonical = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              supplied.user == nil, supplied.password == nil, supplied.query == nil, supplied.fragment == nil,
              supplied.path.isEmpty || supplied.path == "/",
              supplied.scheme?.lowercased() == canonical.scheme,
              supplied.host?.lowercased() == canonical.host,
              (supplied.port ?? (canonical.scheme == "https" ? 443 : 80))
                == (canonical.port ?? (canonical.scheme == "https" ? 443 : 80)),
              Self.validCredential(token) else { throw HubAccountError.invalidEndpoint }
        try RemoteTarget(hostID: hostID, runtimeID: hostID).validate()
        let endpoint = try HubConnection.endpoint(hubURL: origin, hostID: hostID,
                                                  allowLoopbackHTTP: origin.scheme == "http", runtimeID: runtimeID)
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        return request
    }

    private struct SignIn: Encodable { let email: String; let password: String }
    private struct SocialSignIn: Encodable { let provider: String; let callbackURL: String }
    private struct SocialStart: Decodable { let url: String }
    /// What the hub is told when a one-time code is traded for a session.
    ///
    /// `client` lets the hub file this sign-in under "phone app" instead of
    /// guessing from the User-Agent. The hub treats it as optional, but a
    /// native client that stays silent relies on its agent string, which is the
    /// sort of thing that changes without anyone noticing. Internal rather than
    /// private so a test can assert the wire shape.
    struct Exchange: Encodable {
        let code: String
        let client: String
    }
    private struct ExchangeResult: Decodable { let token: String }
    private struct Token: Decodable { let token: String }
    private struct Directory: Decodable { let data: [HubDirectoryHost] }
    private struct HubVersion: Decodable {
        let protocolVersion: Int
        let capabilities: [String]
        enum CodingKeys: String, CodingKey { case protocolVersion = "protocol", capabilities }
    }
    private struct PushRevocation: Encodable { let deviceID: String }
    private struct PushRevoked: Decodable { let revoked: Bool }

    private func send(_ path: String, credential: String? = nil, body: Data? = nil,
                      query: [URLQueryItem] = []) async throws -> (Data, HTTPURLResponse) {
        var components = URLComponents(url: origin.appendingPathComponent(String(path.dropFirst())), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw HubAccountError.invalidEndpoint }
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let credential { request.setValue("Bearer " + credential, forHTTPHeaderField: "Authorization") }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else { throw HubAccountError.malformed }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 { throw HubAccountError.authenticationRequired }
            throw HubAccountError.rejected(response.statusCode)
        }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 128 * 1024 else { throw HubAccountError.malformed }
            data.append(byte)
        }
        return (data, response)
    }

    private static func validCredential(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 8192 && value.unicodeScalars.allSatisfy { (33...126).contains($0.value) }
    }

    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: keychainService,
         kSecAttrAccount as String: origin.absoluteString,
         kSecAttrSynchronizable as String: false]
    }

    private func save(_ credential: String) throws {
        let data = Data(credential.utf8)
        let status = SecItemUpdate(keychainQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw HubAccountError.storage(status) }
        var entry = keychainQuery
        entry[kSecValueData as String] = data
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(entry as CFDictionary, nil)
        guard added == errSecSuccess else { throw HubAccountError.storage(added) }
    }

    private func clear() throws {
        relaySockets.forEach { $0.cancel(with: .policyViolation, reason: nil) }
        relaySockets.removeAll()
        generation &+= 1
        login = nil
        access = nil
        let status = SecItemDelete(keychainQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw HubAccountError.storage(status) }
    }
}
