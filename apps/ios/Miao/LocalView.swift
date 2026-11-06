import SwiftUI

/// The phone-only mode: no account, no computer, no relay.
struct LocalView: View {
    @Bindable var agent: LocalAgent
    @State private var draft = ""
    @State private var configuring = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !agent.ready {
                    setup
                } else {
                    transcript
                }
                composer
            }
            .navigationTitle(agent.provider.model.isEmpty ? "本机" : agent.provider.model)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { configuring = true } label: { Image(systemName: "slider.horizontal.3") }
                        .accessibilityIdentifier("localSettings")
                }
                ToolbarItem(placement: .topBarLeading) {
                    if !agent.messages.isEmpty {
                        Button("清空", role: .destructive) { agent.clear() }
                    }
                }
            }
            .sheet(isPresented: $configuring) {
                LocalConfigView(agent: agent)
            }
        }
    }

    private var setup: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "iphone.gen3").font(.system(size: 44)).foregroundStyle(.secondary)
            Text("在这台手机上直接使用").font(.headline)
            Text("填一个模型服务商即可开始，不连接任何电脑。")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("配置服务商") { configuring = true }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("localConfigure")
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(agent.messages) { message in row(message) }
                    if agent.busy {
                        HStack(spacing: 8) { ProgressView(); Text("正在处理…").font(.footnote).foregroundStyle(.secondary) }
                    }
                    if let error = agent.error {
                        Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled)
                    }
                }
                .padding(.horizontal).padding(.vertical, 12)
            }
            .onChange(of: agent.messages.count) { _, _ in
                if let last = agent.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    @ViewBuilder private func row(_ message: LocalMessage) -> some View {
        switch message.role {
        case .user:
            HStack { Spacer(minLength: 40)
                Text(message.text).padding(10).background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12)) }
        case .assistant:
            LocalMarkdown(text: message.text)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        case .tool:
            VStack(alignment: .leading, spacing: 4) {
                Label(message.toolName ?? "tool", systemImage: "hammer").font(.caption).foregroundStyle(.secondary)
                Text(message.text).font(.system(.caption, design: .monospaced)).lineLimit(8)
            }
            .padding(8).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("说点什么…", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                .focused($focused)
                .disabled(!agent.ready)
                .accessibilityIdentifier("localInput")
            if agent.busy {
                Button { agent.stop() } label: { Image(systemName: "stop.circle.fill").font(.title2) }
                    .accessibilityIdentifier("localStop")
            } else {
                Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .disabled(!agent.ready || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("localSend")
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        let text = draft
        draft = ""
        agent.send(text)
    }
}

private struct LocalConfigView: View {
    @Bindable var agent: LocalAgent
    @Environment(\.dismiss) private var dismiss
    @State private var editing: LocalProvider?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(agent.providers) { item in
                        Button {
                            editing = item
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.name.isEmpty ? item.model : item.name).foregroundStyle(.primary)
                                    Text(item.model).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if agent.selectedID == item.id {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) { agent.remove(item.id) } label: { Label("删除", systemImage: "trash") }
                            Button { agent.select(item.id) } label: { Label("使用", systemImage: "checkmark") }
                        }
                    }
                } header: {
                    Text("服务商")
                } footer: {
                    Text("点一条进行编辑；左滑可以删除或设为当前使用。密钥只保存在这台手机上。")
                }
                Section {
                    Button { editing = LocalProvider() } label: { Label("添加服务商", systemImage: "plus") }
                }
            }
            .navigationTitle("本机服务商")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .sheet(item: $editing) { item in ProviderEditor(agent: agent, item: item) }
        }
    }
}

private struct ProviderEditor: View {
    @Bindable var agent: LocalAgent
    @Environment(\.dismiss) private var dismiss
    @State private var draft: LocalProvider

    init(agent: LocalAgent, item: LocalProvider) {
        self.agent = agent
        _draft = State(initialValue: item)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("名称（可选）", text: $draft.name)
                    TextField("接口地址", text: $draft.baseURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityIdentifier("localBaseURL")
                    SecureField("API Key", text: $draft.apiKey)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("localAPIKey")
                    TextField("模型名称", text: $draft.model)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("localModel")
                } footer: {
                    Text("兼容 OpenAI 的 /chat/completions 接口，例如火山引擎的 https://ark.cn-beijing.volces.com/api/v3。")
                }
            }
            .navigationTitle(draft.model.isEmpty ? "新的服务商" : "编辑服务商")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        var next = draft
                        if next.name.isEmpty { next.name = next.model }
                        agent.save(next)
                        agent.select(next.id)
                        dismiss()
                    }
                    .disabled(draft.baseURL.isEmpty || draft.apiKey.isEmpty || draft.model.isEmpty)
                    .accessibilityIdentifier("localSave")
                }
            }
        }
    }
}
