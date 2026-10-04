import Foundation
import CryptoKit
import Security

/// The key is never placed in preferences, checkpoint files, iCloud, or logs.
public actor DeviceIdentity {
    private let service: String
    private let account: String

    public init(service: String = "miao.remote.device", account: String = "identity-v1") {
        self.service = service
        self.account = account
    }

    public func loadOrCreate() throws -> P256.Signing.PrivateKey {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess {
            guard let data = item as? Data else { throw ClientStateError.invalidStorage }
            return try P256.Signing.PrivateKey(rawRepresentation: data)
        }
        guard status == errSecItemNotFound else { throw ClientStateError.identityUnavailable(status) }
        let key = P256.Signing.PrivateKey()
        var entry = baseQuery
        entry[kSecValueData as String] = key.rawRepresentation
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let saved = SecItemAdd(entry as CFDictionary, nil)
        // Another process/window may have won creation. Re-read the existing key.
        if saved == errSecDuplicateItem { return try loadOrCreate() }
        guard saved == errSecSuccess else { throw ClientStateError.identityUnavailable(saved) }
        return key
    }

    public func remove() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ClientStateError.identityUnavailable(status)
        }
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }
}
