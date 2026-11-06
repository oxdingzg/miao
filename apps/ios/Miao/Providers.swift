import Foundation
import MiaoCore

/// One provider as the phone is allowed to see it: identity, how it can be
/// connected, and whether it currently has a usable connection. Credential
/// values never reach the device, so nothing here can be used to read a key.
struct ProviderSummary: Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let connected: Bool
    let allowsKey: Bool
    let environment: [String]

    init?(_ value: JSONValue) {
        guard let id = value["id"]?.string, let name = value["name"]?.string else { return nil }
        let methods = value["methods"]?.array ?? []
        self.id = id
        self.name = name
        self.connected = value["connected"]?.bool ?? false
        self.allowsKey = methods.contains { $0["type"]?.string == "key" }
        self.environment = methods
            .filter { $0["type"]?.string == "env" }
            .flatMap { $0["names"]?.array?.compactMap(\.string) ?? [] }
    }

    /// A provider is reachable from the phone only when it accepts a key.
    var editable: Bool { allowsKey }
}

struct ModelChoice: Identifiable, Sendable, Equatable, Hashable {
    let providerID: String
    let modelID: String
    let name: String

    var id: String { providerID + "/" + modelID }

    init?(_ value: JSONValue) {
        guard let providerID = value["providerID"]?.string,
              let modelID = value["id"]?.string,
              let name = value["name"]?.string
        else { return nil }
        self.providerID = providerID
        self.modelID = modelID
        self.name = name
    }
}

struct ProviderDirectory: Sendable, Equatable {
    let providers: [ProviderSummary]
    let models: [ModelChoice]
    /// Provider id to the model id the host currently resolves by default.
    let defaults: [String: String]

    init?(_ value: JSONValue) {
        guard let providers = value["providers"]?.array, let models = value["models"]?.array else { return nil }
        let parsed = providers.compactMap(ProviderSummary.init)
        guard parsed.count == providers.count else { return nil }
        self.providers = parsed.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        self.models = models.compactMap(ModelChoice.init)
        self.defaults = (value["default"]?.object ?? [:]).compactMapValues(\.string)
    }

    func models(of providerID: String) -> [ModelChoice] {
        models.filter { $0.providerID == providerID }
    }

    /// The host reports a default per provider; the phone shows the first one
    /// that still exists rather than inventing a selection of its own.
    var selected: ModelChoice? {
        for provider in providers {
            guard let modelID = defaults[provider.id] else { continue }
            if let match = models.first(where: { $0.providerID == provider.id && $0.modelID == modelID }) { return match }
        }
        return nil
    }
}

@MainActor
extension HostClient {
    /// Only an owner-granted `provider.configure` may change credentials.
    var canConfigureProviders: Bool { record.grant.permissions.contains(.providerConfigure) }

    func loadProviders() async {
        guard ready else { return }
        do {
            let value = try await request(.providerList)
            guard let directory = ProviderDirectory(value) else {
                throw RemoteConnectionError.protocolIncompatible
            }
            providers = directory
            providersError = nil
        } catch {
            providersError = userMessage(error)
        }
    }

    func connectProviderKey(_ providerID: String, key: String) async throws {
        try await configure(.providerConnectKey, payload: .object([
            "providerID": .string(providerID),
            "key": .string(key),
        ]))
    }

    func disconnectProvider(_ providerID: String) async throws {
        try await configure(.providerDisconnect, payload: .object(["providerID": .string(providerID)]))
    }

    func setDefaultModel(_ model: ModelChoice) async throws {
        try await configure(.modelDefault, payload: .object([
            "providerID": .string(model.providerID),
            "modelID": .string(model.modelID),
        ]))
    }

    /// Provider writes carry a fresh operation id but are deliberately absent
    /// from the checkpoint ledger: the request body may hold a credential, and
    /// every outcome is reconciled by re-reading `provider.list`.
    private func configure(_ method: RemoteMethod, payload: JSONValue) async throws {
        let result = try await request(method, operationID: UUID(), payload: payload)
        // The host may have applied the change even when the receipt is
        // uncertain, so read the authoritative state before reporting.
        await loadProviders()
        guard result["status"]?.string == "completed" else {
            throw RemoteRPCError.rejected(result["code"]?.string ?? "uncertain")
        }
    }
}
