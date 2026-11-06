import SwiftUI

/// Provider and model settings for one connected computer.
///
/// The screen only ever holds what `provider.list` reports: names, whether a
/// provider has a live connection and which models exist. A key typed here is
/// sent once over the encrypted channel and never stored on the phone.
struct ProvidersView: View {
    let client: HostClient
    @Environment(\.dismiss) private var dismiss
    @State private var target: ProviderSummary?
    @State private var disconnectTarget: ProviderSummary?
    @State private var key = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var message: String?

    var body: some View {
        NavigationStack {
            List {
                if let failure {
                    Section { Text(failure).foregroundStyle(.red).font(.footnote) }
                }
                if let message {
                    Section { Text(message).foregroundStyle(.secondary).font(.footnote) }
                }
                if !client.canConfigureProviders {
                    Section {
                        Text("电脑上的这次授权没有包含「允许配置服务商与模型」。请在电脑上重新发起邀请，并在权限一步选择该项。")
                            .font(.footnote)
                    } header: { Text("需要授权") }
                }
                if client.ready {
                    defaultSection
                    connectedSection
                    availableSection
                    environmentSection
                } else {
                    Section { Text(client.connectionDescription).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("服务商与模型")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await client.loadProviders() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(!client.ready)
                    .accessibilityIdentifier("providerRefresh")
                }
            }
            .task { await client.loadProviders() }
            .refreshable { await client.loadProviders() }
            .sheet(item: $target) { provider in keySheet(provider) }
            .confirmationDialog(
                disconnectTarget.map { "断开 \($0.name)？" } ?? "断开服务商？",
                isPresented: Binding(
                    get: { disconnectTarget != nil },
                    set: { if !$0 { disconnectTarget = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("断开", role: .destructive) {
                    guard let provider = disconnectTarget else { return }
                    disconnectTarget = nil
                    Task { await disconnect(provider) }
                }
                Button("取消", role: .cancel) { disconnectTarget = nil }
            } message: {
                Text("只删除电脑上保存的凭据，之后可以重新填写。")
            }
        }
    }

    @ViewBuilder private var defaultSection: some View {
        Section {
            if let directory = client.providers, let selected = directory.selected {
                NavigationLink {
                    ModelPicker(directory: directory, selection: selected, pick: setDefault)
                } label: {
                    LabeledContent("默认模型", value: selected.name)
                }
            } else if let directory = client.providers, !directory.models.isEmpty {
                NavigationLink {
                    ModelPicker(directory: directory, selection: nil, pick: setDefault)
                } label: {
                    LabeledContent("默认模型", value: "未设置")
                }
            } else {
                LabeledContent("默认模型", value: "还没有可用模型")
            }
        } header: {
            Text("新会话")
        } footer: {
            Text("在手机上选定后，电脑上新开的会话默认使用这个模型。")
        }
    }

    @ViewBuilder private var connectedSection: some View {
        let connected = client.providers?.providers.filter(\.connected) ?? []
        Section("已连接") {
            if connected.isEmpty {
                Text("还没有已连接的服务商").foregroundStyle(.secondary)
            }
            ForEach(connected) { provider in
                HStack {
                    Text(provider.name)
                    Spacer()
                    if provider.editable, client.canConfigureProviders {
                        Button("断开", role: .destructive) { disconnectTarget = provider }
                            .buttonStyle(.borderless)
                    } else if !provider.environment.isEmpty {
                        Text(provider.environment.joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                }
            }
        }
    }

    @ViewBuilder private var availableSection: some View {
        let available = (client.providers?.providers ?? []).filter { !$0.connected && $0.editable }
        if client.canConfigureProviders, !available.isEmpty {
            Section("添加 API Key") {
                ForEach(available) { provider in
                    Button {
                        key = ""
                        failure = nil
                        target = provider
                    } label: {
                        HStack {
                            Text(provider.name).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "plus.circle").foregroundStyle(Color.accentColor)
                        }
                    }
                    .accessibilityIdentifier("providerConnect-\(provider.id)")
                }
            }
        }
    }

    @ViewBuilder private var environmentSection: some View {
        let local = (client.providers?.providers ?? []).filter { !$0.connected && $0.environment.isEmpty && !$0.editable }
        if !local.isEmpty {
            Section {
                ForEach(local) { provider in
                    HStack {
                        Text(provider.name)
                        Spacer()
                        Text("在电脑上连接").font(.caption).foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("只能在电脑上连接")
            } footer: {
                Text("这些服务商需要浏览器登录或被禁用，手机端不提供入口。")
            }
        }
    }

    private func keySheet(_ provider: ProviderSummary) -> some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("API Key", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("providerKey")
                } header: {
                    Text(provider.name)
                } footer: {
                    Text("密钥只经加密连接送到你的电脑并保存在那里；手机不写盘，也不显示已保存的密钥。")
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle("连接服务商")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { close() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("连接") { Task { await connect(provider) } }
                        .disabled(busy || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("providerSubmit")
                }
            }
        }
    }

    private func close() {
        target = nil
        key = ""
        failure = nil
    }

    private func connect(_ provider: ProviderSummary) async {
        busy = true
        failure = nil
        do {
            try await client.connectProviderKey(provider.id, key: key.trimmingCharacters(in: .whitespacesAndNewlines))
            close()
            message = "\(provider.name) 已连接"
        } catch {
            failure = userMessage(error)
        }
        busy = false
    }

    private func disconnect(_ provider: ProviderSummary) async {
        busy = true
        failure = nil
        do {
            try await client.disconnectProvider(provider.id)
            message = "\(provider.name) 已断开"
        } catch {
            failure = userMessage(error)
        }
        busy = false
    }

    private func setDefault(_ model: ModelChoice) async {
        busy = true
        failure = nil
        do {
            try await client.setDefaultModel(model)
            message = "默认模型已改为 \(model.name)"
        } catch {
            failure = userMessage(error)
        }
        busy = false
    }
}

private struct ModelPicker: View {
    let directory: ProviderDirectory
    let selection: ModelChoice?
    let pick: (ModelChoice) async -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            ForEach(directory.providers.filter { !directory.models(of: $0.id).isEmpty }) { provider in
                Section(provider.name) {
                    ForEach(directory.models(of: provider.id)) { model in
                        Button {
                            dismiss()
                            Task { await pick(model) }
                        } label: {
                            HStack {
                                Text(model.name).foregroundStyle(.primary)
                                Spacer()
                                if model == selection {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("默认模型")
        .navigationBarTitleDisplayMode(.inline)
    }
}
