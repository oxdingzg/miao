import Foundation
import CryptoKit

public struct AuthorizedHost: Codable, Sendable, Equatable, Identifiable {
    public let host: ApprovedHost
    public let grant: DeviceGrant
    public var id: UUID { host.id }
    public init(host: ApprovedHost, grant: DeviceGrant) { self.host = host; self.grant = grant }
    public var expired: Bool { grant.expiresAt <= Int64(Date().timeIntervalSince1970 * 1000) }
}

/// Contains public trust/authorization metadata only, never an invitation secret or signing key.
public struct PairingAttempt: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let hubURL: String
    public let target: RemoteTarget
    public let hostPublicKey: String
    public let createdAt: Date
}

public actor HostRegistry {
    private struct State: Codable {
        let version: Int
        let deviceKey: String
        var hosts: [AuthorizedHost]
        var attempts: [PairingAttempt]
    }
    private let file: URL
    private let deviceKey: String
    private let allowLoopbackHTTP: Bool
    private var state: State?

    public init(directory: URL, deviceKey: String, allowLoopbackHTTP: Bool = false) throws {
        guard directory.isFileURL else { throw ClientStateError.invalidStorage }
        file = directory.appendingPathComponent("hosts-v1.json")
        self.deviceKey = deviceKey
        self.allowLoopbackHTTP = allowLoopbackHTTP
    }
    public func hosts() throws -> [AuthorizedHost] { try load().hosts }
    public func attempts() throws -> [PairingAttempt] { try load().attempts }
    public func snapshot() throws -> (hosts: [AuthorizedHost], attempts: [PairingAttempt]) {
        let value = try load()
        return (value.hosts, value.attempts)
    }

    /// Persist the trust anchor before transmitting a claim, so uncertain approval can be reconciled later.
    public func begin(_ invitation: PairingInvitation) throws {
        try invitation.validate(allowLoopbackHTTP: allowLoopbackHTTP)
        var next = try load()
        next.attempts.removeAll { $0.id == invitation.pairingID }
        next.attempts.append(PairingAttempt(id: invitation.pairingID, hubURL: invitation.hubURL,
                                          target: invitation.target, hostPublicKey: invitation.hostPublicKey, createdAt: Date()))
        try persist(next)
    }

    public func approve(host: ApprovedHost, grant: DeviceGrant, pairingID: String) throws {
        try grant.validate(deviceKey: deviceKey)
        guard host.grantID == grant.id, host.grantVersion == grant.version else { throw ClientStateError.scopeMismatch }
        var next = try load()
        guard let attempt = next.attempts.first(where: { $0.id == pairingID }),
              attempt.target == host.target, attempt.hostPublicKey == host.publicKey,
              attempt.hubURL == host.hubURL.absoluteString else { throw ClientStateError.scopeMismatch }
        next.hosts.removeAll { $0.host.target.hostID == host.target.hostID && $0.grant.id == grant.id }
        next.hosts.append(AuthorizedHost(host: host, grant: grant))
        next.attempts.removeAll { $0.id == pairingID }
        try persist(next)
    }

    /// Installs an encrypted grant from the computer's same-account auto-admission.
    public func admitAuto(host: ApprovedHost, grant: DeviceGrant) throws {
        try grant.validate(deviceKey: deviceKey)
        guard host.grantID == grant.id, host.grantVersion == grant.version,
              !host.label.isEmpty, host.label.utf16.count <= 128 else { throw ClientStateError.scopeMismatch }
        var next = try load()
        next.hosts.removeAll { $0.host.hubURL == host.hubURL && $0.host.target.hostID == host.target.hostID && $0.grant.id == grant.id }
        next.hosts.append(AuthorizedHost(host: host, grant: grant))
        try persist(next)
    }

    /// Computer names come from live directory metadata; a pairing URL only carries identifiers.
    public func rename(_ directory: [HubDirectoryHost], hubURL: URL) throws {
        var next = try load()
        var changed = false
        for index in next.hosts.indices {
            guard next.hosts[index].host.hubURL == hubURL else { continue }
            guard let entry = directory.first(where: {
                $0.hostID == next.hosts[index].host.target.hostID && $0.runtimeID == next.hosts[index].host.target.runtimeID &&
                $0.revokedAt == nil && !$0.name.isEmpty
            }), next.hosts[index].host.label != entry.name else { continue }
            var host = next.hosts[index].host
            host.label = entry.name
            next.hosts[index] = AuthorizedHost(host: host, grant: next.hosts[index].grant)
            changed = true
        }
        guard changed else { return }
        try persist(next)
    }

    /// Install only the encrypted Agent approval for a host independently endorsed in accepted account trust.
    public func admitAccount(host: ApprovedHost, grant: DeviceGrant, enrollment: AcceptedAccountEnrollment) throws {
        try grant.validate(deviceKey: deviceKey)
        guard host.hubURL.absoluteString == enrollment.hubURL,
              host.grantID == grant.id, host.grantVersion == grant.version,
              enrollment.roster.roster.devices.contains(where: { $0.publicKey == deviceKey }),
              enrollment.hosts.contains(where: { $0.hostID == host.target.hostID && $0.publicKey == host.publicKey }),
              try enrollment.roster.fingerprint() == enrollment.authority.digest else { throw ClientStateError.scopeMismatch }
        var next = try load()
        next.hosts.removeAll { $0.host.hubURL == host.hubURL && $0.host.target.hostID == host.target.hostID && $0.grant.id == grant.id }
        next.hosts.append(AuthorizedHost(host: host, grant: grant))
        try persist(next)
    }

    public func forget(_ id: UUID) throws {
        var next = try load()
        next.hosts.removeAll { $0.id == id }
        try persist(next)
    }

    public func forgetAttempt(_ id: String) throws {
        var next = try load()
        next.attempts.removeAll { $0.id == id }
        try persist(next)
    }

    private func load() throws -> State {
        if let state { return state }
        guard FileManager.default.fileExists(atPath: file.path) else {
            return State(version: 1, deviceKey: deviceKey, hosts: [], attempts: [])
        }
        let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true,
              let size = info.fileSize, size <= 16 * 1024 * 1024 else { throw ClientStateError.invalidStorage }
        let saved = try JSONDecoder().decode(State.self, from: Data(contentsOf: file))
        try validate(saved)
        state = saved
        return saved
    }

    private func validate(_ next: State) throws {
        guard next.version == 1, next.deviceKey == deviceKey else { throw ClientStateError.scopeMismatch }
        guard next.hosts.count <= 64, next.attempts.count <= 8,
              Set(next.hosts.map(\.id)).count == next.hosts.count,
              Set(next.attempts.map(\.id)).count == next.attempts.count else { throw ClientStateError.limitExceeded }
        for record in next.hosts {
            // Keep expired metadata for the UI, but never consider it an active grant.
            try record.grant.validate(deviceKey: deviceKey, now: Date(timeIntervalSince1970: 0))
            guard record.host.grantID == record.grant.id, record.host.grantVersion == record.grant.version else {
                throw ClientStateError.scopeMismatch
            }
            try record.host.target.validate()
            _ = try P256.Signing.PublicKey(x963Representation: decodeBase64URL(record.host.publicKey))
            _ = try HubConnection.endpoint(hubURL: record.host.hubURL, hostID: record.host.target.hostID, allowLoopbackHTTP: allowLoopbackHTTP)
        }
        for attempt in next.attempts {
            guard attempt.id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil else {
                throw ClientStateError.invalidStorage
            }
            try attempt.target.validate()
            _ = try P256.Signing.PublicKey(x963Representation: decodeBase64URL(attempt.hostPublicKey))
            _ = try HubConnection.endpoint(hubURL: URL(string: attempt.hubURL), hostID: attempt.target.hostID, allowLoopbackHTTP: allowLoopbackHTTP)
        }
    }

    private func persist(_ next: State) throws {
        try validate(next)
        let data = try JSONEncoder().encode(next)
        guard data.count <= 16 * 1024 * 1024 else { throw ClientStateError.limitExceeded }
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(".hosts-" + UUID().uuidString)
        #if os(iOS)
        let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600, .protectionKey: FileProtectionType.complete]
        #else
        let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #endif
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil, attributes: attributes) else {
            throw ClientStateError.invalidStorage
        }
        defer { try? FileManager.default.removeItem(at: temporary) }
        var excluded = temporary
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        let handle = try FileHandle(forWritingTo: temporary)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch { try? handle.close(); throw error }
        if FileManager.default.fileExists(atPath: file.path) {
            _ = try FileManager.default.replaceItemAt(file, withItemAt: temporary)
        } else { try FileManager.default.moveItem(at: temporary, to: file) }
        state = next
    }
}
