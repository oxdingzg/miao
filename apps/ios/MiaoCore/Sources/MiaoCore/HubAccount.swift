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
    public var id: String { hostID }
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
    private let keychainService: String
    private var login: String?
    private var pendingLogout: String?
    private var access: (value: String, until: Date)?
    private var generation: UInt64 = 0

    public init(origin: URL, keychainService: String = "miao.remote.hub-account",
                allowLoopbackHTTP: Bool = false) throws {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        guard let value = components, value.user == nil, value.password == nil,
              value.query == nil, value.fragment == nil, value.path.isEmpty || value.path == "/",
              let host = value.host, !host.isEmpty,
              value.scheme == "https" || (allowLoopbackHTTP && value.scheme == "http"
                && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
            throw HubAccountError.invalidEndpoint
        }
        components?.path = ""
        guard let normalized = components?.url else { throw HubAccountError.invalidEndpoint }
        self.origin = normalized
        self.keychainService = keychainService
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        self.session = URLSession(configuration: configuration, delegate: HubAccountRedirects(), delegateQueue: nil)
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
        guard hosts.count <= 64, Set(hosts.map(\.hostID)).count == hosts.count,
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
        session.invalidateAndCancel()
    }

    private struct SignIn: Encodable { let email: String; let password: String }
    private struct Token: Decodable { let token: String }
    private struct Directory: Decodable { let data: [HubDirectoryHost] }

    private func send(_ path: String, credential: String? = nil, body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        let url = origin.appendingPathComponent(String(path.dropFirst()))
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
        generation &+= 1
        login = nil
        access = nil
        let status = SecItemDelete(keychainQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw HubAccountError.storage(status) }
    }
}
