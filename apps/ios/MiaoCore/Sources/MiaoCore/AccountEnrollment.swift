import Foundation
import CryptoKit

public struct AccountEnrollmentRequest: Codable, Sendable, Equatable {
    public struct Payload: Codable, Sendable, Equatable {
        public let version: Int
        public let hubURL: String
        public let accountID: String
        public let publicKey: String
        public let challenge: String
        public let label: String
        public let createdAt: Int64
        public let expiresAt: Int64
        var object: [String: Any] {
            ["version": version, "hubURL": hubURL, "accountID": accountID, "publicKey": publicKey,
             "challenge": challenge, "label": label, "createdAt": createdAt, "expiresAt": expiresAt]
        }
    }
    public let payload: Payload
    public let signature: String

    public static func create(identity: P256.Signing.PrivateKey, hubURL: String, accountID: String,
                              label: String, now: Date = Date(), allowLoopbackHTTP: Bool = false) throws -> AccountEnrollmentRequest {
        let at = try enrollmentTimestamp(now)
        guard at <= rosterMaximumInteger - 600000 else { throw AccountRosterError.malformed }
        let payload = Payload(version: 1, hubURL: try rosterOrigin(hubURL, allowLoopbackHTTP: allowLoopbackHTTP), accountID: accountID,
            publicKey: identity.publicKey.x963Representation.base64URL,
            challenge: SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64URL }, label: label, createdAt: at, expiresAt: at + 600000)
        let signature = try identity.signature(for: canonical(["miao.control.enrollment.v1", payload.object]))
        let request = AccountEnrollmentRequest(payload: payload, signature: signature.rawRepresentation.base64URL)
        try request.verify(hubURL: hubURL, accountID: accountID, now: now, allowLoopbackHTTP: allowLoopbackHTTP)
        return request
    }

    public static func decode(_ data: Data) throws -> AccountEnrollmentRequest {
        guard data.count <= 8192 else { throw AccountRosterError.malformed }
        let signed = try rosterObject(JSONDecoder().decode(JSONValue.self, from: data), fields: ["payload", "signature"])
        let value = try rosterObject(signed["payload"], fields: ["version", "hubURL", "accountID", "publicKey", "challenge", "label", "createdAt", "expiresAt"])
        return AccountEnrollmentRequest(payload: Payload(version: Int(try rosterInteger(value["version"])),
            hubURL: try rosterString(value["hubURL"]), accountID: try rosterString(value["accountID"]),
            publicKey: try rosterString(value["publicKey"]), challenge: try rosterString(value["challenge"]), label: try rosterString(value["label"]),
            createdAt: try rosterInteger(value["createdAt"]), expiresAt: try rosterInteger(value["expiresAt"])), signature: try rosterString(signed["signature"]))
    }

    public func verify(hubURL: String, accountID: String, now: Date = Date(), allowLoopbackHTTP: Bool = false) throws {
        let at = try enrollmentTimestamp(now)
        guard payload.version == 1, payload.hubURL == hubURL, payload.accountID == accountID,
              !payload.label.isEmpty, payload.label.utf16.count <= 128 else { throw AccountRosterError.accountMismatch }
        _ = try rosterOrigin(hubURL, allowLoopbackHTTP: allowLoopbackHTTP)
        try rosterIdentifier(accountID)
        guard payload.createdAt >= 0, payload.createdAt <= at + 30000, payload.expiresAt > at,
              payload.expiresAt > payload.createdAt, payload.expiresAt - payload.createdAt <= 600000,
              payload.expiresAt <= rosterMaximumInteger else { throw AccountRosterError.expired }
        _ = try rosterBytes(payload.challenge, length: 32)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: rosterBytes(self.signature, length: 64))
        guard try rosterKey(payload.publicKey).isValidSignature(signature,
            for: canonical(["miao.control.enrollment.v1", payload.object])) else { throw AccountRosterError.untrustedSigner }
    }
}

public struct AccountHostEndorsement: Codable, Sendable, Equatable {
    public struct Payload: Codable, Sendable, Equatable {
        public let version: Int
        public let hubURL: String
        public let accountID: String
        public let deviceKey: String
        public let challenge: String
        public let hosts: [EndorsedAccountHost]
        var object: [String: Any] {
            ["version": version, "hubURL": hubURL, "accountID": accountID, "deviceKey": deviceKey, "challenge": challenge,
             "hosts": hosts.map { ["hostID": $0.hostID, "publicKey": $0.publicKey] }]
        }
    }
    public let payload: Payload
    public let signature: String
    static func parse(_ input: JSONValue?) throws -> AccountHostEndorsement {
        let signed = try rosterObject(input, fields: ["payload", "signature"])
        let value = try rosterObject(signed["payload"], fields: ["version", "hubURL", "accountID", "deviceKey", "challenge", "hosts"])
        guard let hosts = value["hosts"]?.array, !hosts.isEmpty, hosts.count <= 64 else { throw AccountRosterError.malformed }
        let decoded = try hosts.map { host -> EndorsedAccountHost in
            let value = try rosterObject(host, fields: ["hostID", "publicKey"])
            return EndorsedAccountHost(hostID: try rosterString(value["hostID"]), publicKey: try rosterString(value["publicKey"]))
        }
        return AccountHostEndorsement(payload: Payload(version: Int(try rosterInteger(value["version"])), hubURL: try rosterString(value["hubURL"]),
            accountID: try rosterString(value["accountID"]), deviceKey: try rosterString(value["deviceKey"]), challenge: try rosterString(value["challenge"]), hosts: decoded),
            signature: try rosterString(signed["signature"]))
    }
    func validate(request: AccountEnrollmentRequest) throws {
        guard payload.version == 1, payload.hubURL == request.payload.hubURL, payload.accountID == request.payload.accountID,
              payload.deviceKey == request.payload.publicKey, payload.challenge == request.payload.challenge,
              !payload.hosts.isEmpty, payload.hosts.count <= 64 else { throw AccountRosterError.recipientMismatch }
        var previous = ""
        for host in payload.hosts {
            try rosterIdentifier(host.hostID)
            _ = try rosterKey(host.publicKey)
            guard host.hostID > previous else { throw AccountRosterError.malformed }
            previous = host.hostID
        }
    }
}

public struct AcceptedAccountEnrollment: Codable, Sendable, Equatable {
    public let roster: SignedAccountRoster
    public let authority: AccountRosterAuthority
    public let hosts: [EndorsedAccountHost]
}

public struct AccountEnrollmentApproval: Codable, Sendable, Equatable {
    public let version: Int
    public let roster: SignedAccountRoster
    public let endorsement: AccountHostEndorsement

    public static func decode(_ data: Data) throws -> AccountEnrollmentApproval {
        guard data.count <= 131072 else { throw AccountRosterError.malformed }
        let value = try rosterObject(JSONDecoder().decode(JSONValue.self, from: data), fields: ["version", "roster", "endorsement"])
        guard try rosterInteger(value["version"]) == 1 else { throw AccountRosterError.malformed }
        return AccountEnrollmentApproval(version: 1, roster: try SignedAccountRoster.parse(value["roster"]!),
            endorsement: try AccountHostEndorsement.parse(value["endorsement"]))
    }

    public static func approve(identity: P256.Signing.PrivateKey, request: AccountEnrollmentRequest,
                               hubURL: String, current: SignedAccountRoster, authority: AccountRosterAuthority,
                               pairedHosts: [EndorsedAccountHost], now: Date = Date(), allowLoopbackHTTP: Bool = false) throws -> AccountEnrollmentApproval {
        try request.verify(hubURL: hubURL, accountID: authority.accountID, now: now, allowLoopbackHTTP: allowLoopbackHTTP)
        let key = identity.publicKey.x963Representation.base64URL
        guard current.roster.accountID == authority.accountID, current.roster.sequence == authority.sequence,
              try current.fingerprint() == authority.digest, authority.signerKeys.contains(key),
              current.roster.devices.contains(where: { $0.publicKey == key && $0.signer }) else { throw AccountRosterError.untrustedSigner }
        var devices = current.roster.devices
        if !devices.contains(where: { $0.publicKey == request.payload.publicKey }) {
            devices.append(AccountRosterDevice(publicKey: request.payload.publicKey, label: request.payload.label, signer: false, addedAt: try enrollmentTimestamp(now)))
        }
        devices.sort { $0.publicKey < $1.publicKey }
        let roster = try SignedAccountRoster.sign(identity: identity, roster: AccountRosterPayload(accountID: authority.accountID,
            sequence: authority.sequence + 1, issuedAt: enrollmentTimestamp(now), devices: devices))
        let payload = AccountHostEndorsement.Payload(version: 1, hubURL: hubURL, accountID: authority.accountID,
            deviceKey: request.payload.publicKey, challenge: request.payload.challenge, hosts: pairedHosts)
        let endorsement = AccountHostEndorsement(payload: payload, signature: "")
        try endorsement.validate(request: request)
        let signature = try identity.signature(for: canonical(["miao.control.host-endorsement.v1", payload.object]))
        return AccountEnrollmentApproval(version: 1, roster: roster,
            endorsement: AccountHostEndorsement(payload: payload, signature: signature.rawRepresentation.base64URL))
    }

    /// trustedSignerKey is obtained out of band, not from a Hub roster or directory response.
    public func accept(pending: AccountEnrollmentRequest, trustedSignerKey: String,
                       now: Date = Date(), allowLoopbackHTTP: Bool = false) throws -> AcceptedAccountEnrollment {
        guard version == 1 else { throw AccountRosterError.malformed }
        try pending.verify(hubURL: pending.payload.hubURL, accountID: pending.payload.accountID, now: now, allowLoopbackHTTP: allowLoopbackHTTP)
        let accepted = try roster.accept(accountID: pending.payload.accountID,
            previous: AccountRosterAuthority(accountID: pending.payload.accountID, sequence: 0, digest: "", signerKeys: [trustedSignerKey]))
        guard roster.roster.devices.contains(where: { $0.publicKey == pending.payload.publicKey }) else { throw AccountRosterError.recipientMismatch }
        try endorsement.validate(request: pending)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: rosterBytes(endorsement.signature, length: 64))
        guard try rosterKey(trustedSignerKey).isValidSignature(signature,
            for: canonical(["miao.control.host-endorsement.v1", endorsement.payload.object])) else { throw AccountRosterError.untrustedSigner }
        return AcceptedAccountEnrollment(roster: roster, authority: accepted, hosts: endorsement.payload.hosts)
    }
}

/// Actor isolation makes nonce consumption, replacement and cancellation atomic.
public actor AccountEnrollment {
    private let identity: P256.Signing.PrivateKey
    private var pending: AccountEnrollmentRequest?
    public init(identity: P256.Signing.PrivateKey) { self.identity = identity }
    public func cancel() { pending = nil }
    public func begin(hubURL: String, accountID: String, label: String, now: Date? = nil, allowLoopbackHTTP: Bool = false) throws -> Data {
        pending = nil
        let request = try AccountEnrollmentRequest.create(identity: identity, hubURL: hubURL, accountID: accountID, label: label, now: now ?? Date(), allowLoopbackHTTP: allowLoopbackHTTP)
        pending = request
        return try JSONEncoder().encode(request)
    }
    public func receive(_ data: Data, trustedSignerKey: String, now: Date? = nil, allowLoopbackHTTP: Bool = false) throws -> AcceptedAccountEnrollment {
        guard let request = pending else { throw AccountRosterError.noPendingRequest }
        let accepted = try AccountEnrollmentApproval.decode(data).accept(pending: request, trustedSignerKey: trustedSignerKey, now: now ?? Date(), allowLoopbackHTTP: allowLoopbackHTTP)
        pending = nil
        return accepted
    }
}

func enrollmentTimestamp(_ date: Date) throws -> Int64 {
    let value = date.timeIntervalSince1970 * 1000
    guard value.isFinite, value >= 0, value <= Double(rosterMaximumInteger) else { throw AccountRosterError.malformed }
    return Int64(value)
}
