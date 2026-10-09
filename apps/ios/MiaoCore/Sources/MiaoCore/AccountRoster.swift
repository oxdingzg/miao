import Foundation
import CryptoKit

public enum AccountRosterError: Error, Equatable {
    case malformed, accountMismatch, staleOrForked, untrustedSigner, recipientMismatch, expired, noPendingRequest
}

public struct AccountRosterDevice: Codable, Sendable, Equatable {
    public let publicKey: String
    public let label: String
    public let signer: Bool
    public let addedAt: Int64
    public init(publicKey: String, label: String, signer: Bool, addedAt: Int64) {
        self.publicKey = publicKey; self.label = label; self.signer = signer; self.addedAt = addedAt
    }
    var object: [String: Any] { ["publicKey": publicKey, "label": label, "signer": signer, "addedAt": addedAt] }
}

public struct AccountRosterPayload: Codable, Sendable, Equatable {
    public let version: Int
    public let accountID: String
    public let sequence: Int64
    public let issuedAt: Int64
    public let devices: [AccountRosterDevice]
    public init(accountID: String, sequence: Int64, issuedAt: Int64, devices: [AccountRosterDevice]) {
        self.version = 1; self.accountID = accountID; self.sequence = sequence; self.issuedAt = issuedAt; self.devices = devices
    }
    init(version: Int, accountID: String, sequence: Int64, issuedAt: Int64, devices: [AccountRosterDevice]) {
        self.version = version; self.accountID = accountID; self.sequence = sequence; self.issuedAt = issuedAt; self.devices = devices
    }
    var object: [String: Any] {
        ["version": version, "accountID": accountID, "sequence": sequence, "issuedAt": issuedAt,
         "devices": devices.map(\.object)]
    }
}

public struct AccountRosterAuthority: Codable, Sendable, Equatable {
    public let accountID: String
    public let sequence: Int64
    public let digest: String
    public let signerKeys: [String]
    public init(accountID: String, sequence: Int64, digest: String, signerKeys: [String]) {
        self.accountID = accountID; self.sequence = sequence; self.digest = digest; self.signerKeys = signerKeys
    }
}

public struct SignedAccountRoster: Codable, Sendable, Equatable {
    public let version: Int
    public let roster: AccountRosterPayload
    public let signature: String

    public static func sign(identity: P256.Signing.PrivateKey, roster: AccountRosterPayload) throws -> SignedAccountRoster {
        try SignedAccountRoster(version: 1, roster: roster, signature: Data(repeating: 0, count: 64).base64URL).validate()
        let signature = try identity.signature(for: canonical(["miao.control.roster.v1", roster.object]))
        return SignedAccountRoster(version: 1, roster: roster, signature: signature.rawRepresentation.base64URL)
    }

    /// Strict transport decoding: unknown fields are not silently stripped before hashing.
    public static func decode(_ data: Data) throws -> SignedAccountRoster {
        guard data.count <= 65536 else { throw AccountRosterError.malformed }
        return try parse(JSONDecoder().decode(JSONValue.self, from: data))
    }

    /// Directory metadata is untrusted until verified against independent local authority.
    public static func hubRecord(_ data: Data, accountID: String) throws -> SignedAccountRoster? {
        guard data.count <= 131072 else { throw AccountRosterError.malformed }
        let envelope = try rosterObject(JSONDecoder().decode(JSONValue.self, from: data), fields: ["roster"])
        if envelope["roster"] == .null { return nil }
        let record = try rosterObject(envelope["roster"], fields: ["accountID", "sequence", "payload", "signature", "digest", "updatedAt"])
        guard try rosterString(record["accountID"]) == accountID else { throw AccountRosterError.accountMismatch }
        let roster = try parse(.object(["version": .number(1), "roster": record["payload"]!, "signature": record["signature"]!]))
        guard roster.roster.accountID == accountID, try rosterInteger(record["sequence"], minimum: 1) == roster.roster.sequence,
              try rosterString(record["digest"]) == roster.fingerprint() else { throw AccountRosterError.malformed }
        _ = try rosterInteger(record["updatedAt"])
        return roster
    }

    public func fingerprint() throws -> String {
        try validate()
        return Data(SHA256.hash(data: try canonical(["miao.control.roster.v1", roster.object]))).base64URL
    }

    /// A same-sequence reconnect uses its already accepted canonical digest, never a new Hub-nominated signer.
    public func accept(accountID: String, previous: AccountRosterAuthority) throws -> AccountRosterAuthority {
        try validate()
        guard roster.accountID == accountID, previous.accountID == accountID else { throw AccountRosterError.accountMismatch }
        let digest = try fingerprint()
        if roster.sequence == previous.sequence {
            guard previous.sequence > 0, digest == previous.digest else { throw AccountRosterError.staleOrForked }
            return previous
        }
        guard roster.sequence > previous.sequence, previous.sequence >= 0,
              !previous.signerKeys.isEmpty, previous.signerKeys.count <= 64,
              Set(previous.signerKeys).count == previous.signerKeys.count else { throw AccountRosterError.staleOrForked }
        let transcript = try canonical(["miao.control.roster.v1", roster.object])
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: rosterBytes(self.signature, length: 64))
        var valid = false
        for key in previous.signerKeys {
            if try rosterKey(key).isValidSignature(signature, for: transcript) { valid = true }
        }
        guard valid else { throw AccountRosterError.untrustedSigner }
        return AccountRosterAuthority(accountID: accountID, sequence: roster.sequence, digest: digest,
            signerKeys: roster.devices.filter(\.signer).map(\.publicKey))
    }

    static func parse(_ input: JSONValue) throws -> SignedAccountRoster {
        let signed = try rosterObject(input, fields: ["version", "roster", "signature"])
        let payload = try rosterObject(signed["roster"], fields: ["version", "accountID", "sequence", "issuedAt", "devices"])
        guard let devices = payload["devices"]?.array, !devices.isEmpty, devices.count <= 64 else { throw AccountRosterError.malformed }
        let decoded = try devices.map { value -> AccountRosterDevice in
            let device = try rosterObject(value, fields: ["publicKey", "label", "signer", "addedAt"])
            guard let signer = device["signer"]?.bool else { throw AccountRosterError.malformed }
            return AccountRosterDevice(publicKey: try rosterString(device["publicKey"]), label: try rosterString(device["label"]),
                signer: signer, addedAt: try rosterInteger(device["addedAt"]))
        }
        let value = SignedAccountRoster(version: Int(try rosterInteger(signed["version"])), roster: AccountRosterPayload(
            version: Int(try rosterInteger(payload["version"])), accountID: try rosterString(payload["accountID"]),
            sequence: try rosterInteger(payload["sequence"], minimum: 1), issuedAt: try rosterInteger(payload["issuedAt"]), devices: decoded),
            signature: try rosterString(signed["signature"]))
        try value.validate()
        return value
    }

    private func validate() throws {
        guard version == 1, roster.version == 1, roster.sequence > 0, roster.sequence <= rosterMaximumInteger,
              roster.issuedAt >= 0, roster.issuedAt <= rosterMaximumInteger,
              !roster.devices.isEmpty, roster.devices.count <= 64 else { throw AccountRosterError.malformed }
        try rosterIdentifier(roster.accountID)
        _ = try rosterBytes(signature, length: 64)
        var previous = ""
        for device in roster.devices {
            guard device.publicKey > previous, !device.label.isEmpty, device.label.utf16.count <= 128,
                  device.addedAt >= 0, device.addedAt <= rosterMaximumInteger else { throw AccountRosterError.malformed }
            _ = try rosterKey(device.publicKey)
            previous = device.publicKey
        }
    }
}

public struct EndorsedAccountHost: Codable, Sendable, Equatable {
    public let hostID: String
    public let publicKey: String
    public init(hostID: String, publicKey: String) { self.hostID = hostID; self.publicKey = publicKey }
}

let rosterMaximumInteger: Int64 = 9_007_199_254_740_991
func rosterObject(_ value: JSONValue?, fields: Set<String>) throws -> [String: JSONValue] {
    guard let object = value?.object, Set(object.keys) == fields else { throw AccountRosterError.malformed }
    return object
}
func rosterString(_ value: JSONValue?) throws -> String {
    guard let string = value?.string else { throw AccountRosterError.malformed }
    return string
}
func rosterInteger(_ value: JSONValue?, minimum: Int64 = 0) throws -> Int64 {
    guard let number = value?.number, number.isFinite, number >= Double(minimum),
          number <= Double(rosterMaximumInteger), number.rounded(.towardZero) == number else { throw AccountRosterError.malformed }
    return Int64(number)
}
func rosterIdentifier(_ value: String) throws {
    guard value.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil else { throw AccountRosterError.malformed }
}
func rosterBytes(_ value: String, length: Int) throws -> Data {
    let data = try decodeBase64URL(value)
    guard data.count == length else { throw AccountRosterError.malformed }
    return data
}
func rosterKey(_ value: String) throws -> P256.Signing.PublicKey {
    let bytes = try rosterBytes(value, length: 65)
    guard bytes.first == 4 else { throw AccountRosterError.malformed }
    return try P256.Signing.PublicKey(x963Representation: bytes)
}
func rosterOrigin(_ value: String, allowLoopbackHTTP: Bool = false) throws -> String {
    guard var parts = URLComponents(string: value), parts.user == nil, parts.password == nil,
          parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
          let host = parts.host?.lowercased(), !host.isEmpty, let scheme = parts.scheme?.lowercased(),
          scheme == "https" || (allowLoopbackHTTP && scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
          parts.port == nil || (1...65535).contains(parts.port!) else { throw AccountRosterError.malformed }
    parts.scheme = scheme; parts.host = host; parts.path = ""
    if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) { parts.port = nil }
    guard let normalized = parts.url?.absoluteString, normalized == value else { throw AccountRosterError.malformed }
    return normalized
}
