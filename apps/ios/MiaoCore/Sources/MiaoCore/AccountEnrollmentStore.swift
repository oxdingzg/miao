import Foundation

/// Persists accepted roster authority and independent host pins together, bound to one device identity.
public actor AccountEnrollmentStore {
    private struct State: Codable {
        let version: Int
        let deviceKey: String
        var accounts: [AcceptedAccountEnrollment]
    }
    private let file: URL
    private let deviceKey: String
    private let allowLoopbackHTTP: Bool
    private var cached: State?
    public init(directory: URL, deviceKey: String, allowLoopbackHTTP: Bool = false) throws {
        guard directory.isFileURL else { throw ClientStateError.invalidStorage }
        _ = try rosterKey(deviceKey)
        self.file = directory.appendingPathComponent("account-rosters-v1.json")
        self.deviceKey = deviceKey; self.allowLoopbackHTTP = allowLoopbackHTTP
    }
    public func account(hubURL: String, accountID: String) throws -> AcceptedAccountEnrollment? {
        try load().accounts.first { $0.hubURL == hubURL && $0.authority.accountID == accountID }
    }
    public func accept(_ enrollment: AcceptedAccountEnrollment) throws {
        try validate(enrollment)
        guard enrollment.roster.roster.devices.contains(where: { $0.publicKey == deviceKey }) else { throw AccountRosterError.recipientMismatch }
        var next = try load()
        if let previous = next.accounts.first(where: { $0.hubURL == enrollment.hubURL && $0.authority.accountID == enrollment.authority.accountID }) {
            guard enrollment.authority.sequence >= previous.authority.sequence,
                  enrollment.authority.sequence != previous.authority.sequence || enrollment.authority.digest == previous.authority.digest else {
                throw AccountRosterError.staleOrForked
            }
        }
        next.accounts.removeAll { $0.hubURL == enrollment.hubURL && $0.authority.accountID == enrollment.authority.accountID }
        next.accounts.append(enrollment)
        try persist(next)
    }
    public func refresh(_ roster: SignedAccountRoster, hubURL: String, accountID: String) throws -> AcceptedAccountEnrollment {
        var next = try load()
        guard let index = next.accounts.firstIndex(where: { $0.hubURL == hubURL && $0.authority.accountID == accountID }) else {
            throw AccountRosterError.untrustedSigner
        }
        let previous = next.accounts[index]
        let authority = try roster.accept(accountID: accountID, previous: previous.authority)
        if authority == previous.authority { return previous }
        let updated = AcceptedAccountEnrollment(hubURL: hubURL, roster: roster, authority: authority, hosts: previous.hosts)
        try validate(updated)
        next.accounts[index] = updated
        // Retain authenticated removal/sequence advancement even when this device is no longer a member.
        try persist(next)
        return updated
    }
    private func validate(_ enrollment: AcceptedAccountEnrollment) throws {
        _ = try rosterOrigin(enrollment.hubURL, allowLoopbackHTTP: allowLoopbackHTTP)
        guard enrollment.authority.sequence > 0, enrollment.roster.roster.accountID == enrollment.authority.accountID,
              enrollment.roster.roster.sequence == enrollment.authority.sequence,
              try enrollment.roster.fingerprint() == enrollment.authority.digest,
              enrollment.authority.signerKeys == enrollment.roster.roster.devices.filter(\.signer).map(\.publicKey),
              !enrollment.hosts.isEmpty, enrollment.hosts.count <= 64 else { throw AccountRosterError.malformed }
        var previous = ""
        for host in enrollment.hosts {
            try rosterIdentifier(host.hostID)
            _ = try rosterKey(host.publicKey)
            guard host.hostID > previous else { throw AccountRosterError.malformed }
            previous = host.hostID
        }
    }
    private func load() throws -> State {
        if let cached { return cached }
        guard FileManager.default.fileExists(atPath: file.path) else {
            return State(version: 1, deviceKey: deviceKey, accounts: [])
        }
        let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true, let size = info.fileSize, size <= 2 * 1024 * 1024 else {
            throw ClientStateError.invalidStorage
        }
        let state = try JSONDecoder().decode(State.self, from: Data(contentsOf: file))
        try validate(state)
        cached = state
        return state
    }
    private func validate(_ state: State) throws {
        guard state.version == 1, state.deviceKey == deviceKey, state.accounts.count <= 16,
              Set(state.accounts.map { $0.hubURL + "|" + $0.authority.accountID }).count == state.accounts.count else { throw ClientStateError.invalidStorage }
        for enrollment in state.accounts { try validate(enrollment) }
    }
    private func persist(_ next: State) throws {
        try validate(next)
        let data = try JSONEncoder().encode(next)
        guard data.count <= 2 * 1024 * 1024 else { throw ClientStateError.limitExceeded }
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(".account-rosters-" + UUID().uuidString)
        #if os(iOS)
        let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600, .protectionKey: FileProtectionType.complete]
        #else
        let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #endif
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil, attributes: attributes) else { throw ClientStateError.invalidStorage }
        defer { try? FileManager.default.removeItem(at: temporary) }
        var excluded = temporary
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        let handle = try FileHandle(forWritingTo: temporary)
        do { try handle.write(contentsOf: data); try handle.synchronize(); try handle.close() }
        catch { try? handle.close(); throw error }
        if FileManager.default.fileExists(atPath: file.path) { _ = try FileManager.default.replaceItemAt(file, withItemAt: temporary) }
        else { try FileManager.default.moveItem(at: temporary, to: file) }
        cached = next
    }
}
