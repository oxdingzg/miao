import PhotosUI
import SwiftUI

/// The phone-only mode: no account, no computer, no relay.
struct LocalView: View {
    @Bindable var agent: LocalAgent
    @State private var draft = ""
    @State private var configuring = false
    @State private var sidebarVisible = false
    /// False while the reader is looking further up; then streaming must not
    /// yank the transcript back down.
    @State private var followsLatest = true
    @State private var viewport: CGFloat = 0
    @State private var picked: [PhotosPickerItem] = []
    @State private var attachments: [UIImage] = []
    @State private var speech = SpeechInput()
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ZStack(alignment: .leading) {
                VStack(spacing: 0) {
                    if !agent.ready {
                        setup
                    } else {
                        transcript
                    }
                    composer
                }
                .accessibilityHidden(sidebarVisible)
                .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
                    // Only a drag that starts at the left edge opens the drawer.
                    if !sidebarVisible, value.startLocation.x < 28, value.translation.width > 60 { open() }
                })
                if sidebarVisible {
                    Color.black.opacity(0.3).ignoresSafeArea()
                        .onTapGesture { close() }
                    SessionDrawer(agent: agent, close: close)
                        .frame(maxWidth: 300, maxHeight: .infinity)
                        .background(.background)
                        .transition(.move(edge: .leading))
                        .gesture(DragGesture().onEnded { value in
                            if value.translation.width < -60 { close() }
                        })
                }
            }
            .navigationTitle(agent.provider.model.isEmpty ? "本机" : agent.provider.model)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { configuring = true } label: { Image(systemName: "slider.horizontal.3") }
                        .accessibilityIdentifier("localSettings")
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button { sidebarVisible ? close() : open() } label: { Image(systemName: "list.bullet") }
                        .accessibilityIdentifier("localSessions")
                }
            }
            .sheet(isPresented: $configuring) {
                LocalConfigView(agent: agent)
            }

        }
    }

    private let bottom = "bottom"

    /// Keep the newest content visible: no animation while streaming, so the
    /// text does not fight the scroll on every token.
    private func pin(_ proxy: ScrollViewProxy) {
        guard followsLatest else { return }
        proxy.scrollTo(bottom, anchor: .bottom)
    }

    private func open() { withAnimation(.easeInOut(duration: 0.22)) { sidebarVisible = true } }
    private func close() { withAnimation(.easeInOut(duration: 0.22)) { sidebarVisible = false } }

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
                    // A real anchor at the end scrolls past the last bubble, which
                    // anchoring to a message cannot do while it grows.
                    Color.clear.frame(height: 1).id(bottom)
                        .background(GeometryReader { geo in
                            Color.clear
                                .onChange(of: geo.frame(in: .named("transcript")).minY) { _, y in
                                    guard viewport > 0 else { return }
                                    // Visible while the anchor sits inside the
                                    // scroll viewport.
                                    followsLatest = y <= viewport
                                }
                        })
                }
                .padding(.horizontal).padding(.vertical, 12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .coordinateSpace(name: "transcript")
            .scrollDismissesKeyboard(.interactively)
            .onTapGesture { focused = false }
            .onChange(of: agent.messages.count) { _, _ in pin(proxy) }
            .onChange(of: agent.messages.last?.text) { _, _ in pin(proxy) }
            .onChange(of: focused) { _, _ in
                followsLatest = true
                pin(proxy)
            }
            .onAppear { pin(proxy) }
            .overlay(alignment: .bottomTrailing) {
                if !followsLatest {
                    Button {
                        followsLatest = true
                        pin(proxy)
                    } label: {
                        Label("跳到最新", systemImage: "arrow.down")
                            .font(.footnote).padding(.horizontal, 10).padding(.vertical, 6)
                            .background(.thinMaterial, in: Capsule())
                    }
                    .padding(.trailing, 12).padding(.bottom, 12)
                    .accessibilityIdentifier("localJumpLatest")
                }
            }
            .background(GeometryReader { geo in
                Color.clear.onAppear { viewport = geo.size.height }
                    .onChange(of: geo.size.height) { _, value in viewport = value }
            })
        }
    }

    @ViewBuilder private func row(_ message: LocalMessage) -> some View {
        switch message.role {
        case .user:
            HStack { Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 6) {
                    if !message.images.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(message.images.prefix(4), id: \.self) { encoded in
                                if let data = Data(base64Encoded: encoded), let image = UIImage(data: data) {
                                    Image(uiImage: image).resizable().scaledToFill()
                                        .frame(width: 64, height: 64)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }
                    if !message.text.isEmpty {
                        Text(message.text).padding(10)
                            .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
        case .assistant:
            LocalMarkdown(text: message.text)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                .contextMenu {
                    Button { UIPasteboard.general.string = message.text } label: {
                        Label("复制回答", systemImage: "doc.on.doc")
                    }
                }
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
        VStack(spacing: 6) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(attachments.enumerated()), id: \.offset) { index, image in
                            Image(uiImage: image)
                                .resizable().scaledToFill()
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .overlay(alignment: .topTrailing) {
                                    Button { attachments.remove(at: index) } label: {
                                        Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.5))
                                    }.padding(2)
                                }
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }
            HStack(spacing: 8) {
                PhotosPicker(selection: $picked, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "photo.on.rectangle").font(.title3)
                }
                .accessibilityIdentifier("localAttach")
                Button { Task { await dictate() } } label: {
                    Image(systemName: speech.recording ? "waveform.circle.fill" : "mic")
                        .font(.title3)
                        .foregroundStyle(speech.recording ? Color.red : Color.accentColor)
                }
                .accessibilityIdentifier("localDictate")
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
                    .disabled(!agent.ready || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty))
                    .accessibilityIdentifier("localSend")
            }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.bar)
        .onChange(of: picked) { _, items in
            Task {
                var loaded: [UIImage] = []
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                        loaded.append(image)
                    }
                }
                attachments = Array(loaded.prefix(4))
            }
        }
    }

    /// Recognition only fills the draft; sending stays an explicit action.
    private func dictate() async {
        if speech.recording { speech.stop(); return }
        await speech.start(text: draft) { recognized, _ in
            draft = recognized
            return true
        }
    }

    private func send() {
        let text = draft
        let images = attachments
        draft = ""
        attachments = []
        picked = []
        agent.send(text, images: images)
    }
}

private struct LocalConfigView: View {
    @Bindable var agent: LocalAgent
    @Environment(\.dismiss) private var dismiss
    @State private var editing: LocalProvider?
    @State private var mcp = ""

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
                Section {
                    TextField("MCP 服务地址（可选）", text: $mcp)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityIdentifier("mcpURL")
                    Button("保存并连接") { Task { await agent.setMCP(mcp) } }
                        .disabled(mcp == (agent.mcpURL ?? ""))
                    if let error = agent.mcpError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    } else if !agent.mcpURL.isNilOrEmpty {
                        Text("已连接：\(agent.mcpURL ?? "")").font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("MCP 工具")
                } footer: {
                    Text("填一个走 HTTP 的 MCP 服务器地址；iOS 上没有 stdio 传输。")
                }
            }
            .navigationTitle("本机服务商")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { mcp = agent.mcpURL ?? "" }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .sheet(item: $editing) { item in ProviderEditor(agent: agent, item: item) }
        }
    }
}

private struct SessionDrawer: View {
    @Bindable var agent: LocalAgent
    var close: () -> Void
    @State private var renaming: LocalSession?
    @State private var title = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("会话").font(.headline)
                Spacer()
                Button { close() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
                    .accessibilityLabel("关闭会话列表")
            }
            .padding(.horizontal).padding(.top, 14).padding(.bottom, 10)

            Button {
                agent.newSession()
                close()
            } label: {
                Label("新会话", systemImage: "plus").frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal).padding(.bottom, 10)
            .accessibilityIdentifier("localNewSession")

            List {
                ForEach(agent.sessions) { item in
                    Button {
                        agent.selectSession(item.id)
                        close()
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title.isEmpty ? "新会话" : item.title).foregroundStyle(.primary)
                                Text(item.updated.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if item.id == agent.currentID {
                                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .contextMenu {
                        Button { renaming = item; title = item.title } label: {
                            Label("重命名", systemImage: "pencil")
                        }
                    }
                }
                .onDelete { offsets in
                    for offset in offsets { agent.deleteSession(agent.sessions[offset].id) }
                }
            }
            .listStyle(.plain)
        }
        .background(.background)
        .alert("重命名会话", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("名称", text: $title)
            Button("保存") {
                if let item = renaming { agent.renameSession(item.id, title: title) }
                renaming = nil
            }
            Button("取消", role: .cancel) { renaming = nil }
        }
    }
}

private extension Optional where Wrapped == String {
    var isNilOrEmpty: Bool { (self ?? "").isEmpty }
}

private struct ProviderEditor: View {
    @Bindable var agent: LocalAgent
    @Environment(\.dismiss) private var dismiss
    @State private var draft: LocalProvider
    @State private var preset: String

    init(agent: LocalAgent, item: LocalProvider) {
        self.agent = agent
        _draft = State(initialValue: item)
        let known = LocalPresets.all.first { $0.baseURL == item.baseURL }?.id
        _preset = State(initialValue: known ?? (item.baseURL.isEmpty ? "" : "custom"))
    }

    private var chosen: LocalPreset? { LocalPresets.named(preset) }

    private func apply(_ id: String) {
        guard let item = LocalPresets.named(id) else { return }
        draft.name = item.name
        draft.baseURL = item.baseURL
        draft.model = item.defaultModel
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("服务商", selection: $preset) {
                        Text("选择…").tag("")
                        ForEach(LocalPresets.all) { item in Text(item.name).tag(item.id) }
                        Text("自定义").tag("custom")
                    }
                    .onChange(of: preset) { _, value in apply(value) }
                    .accessibilityIdentifier("localPreset")
                } footer: {
                    Text("选好服务商后通常只需填 API Key。")
                }
                Section {
                    SecureField("API Key", text: $draft.apiKey)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("localAPIKey")
                    if let items = chosen?.models, !items.isEmpty {
                        Picker("模型", selection: $draft.model) {
                            ForEach(items, id: \.self) { item in Text(item).tag(item) }
                        }
                    } else {
                        TextField("模型名称", text: $draft.model)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("localModel")
                    }
                } header: {
                    Text(chosen?.name ?? "连接")
                }
                if chosen == nil {
                    Section {
                        TextField("名称", text: $draft.name)
                        TextField("接口地址", text: $draft.baseURL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .accessibilityIdentifier("localBaseURL")
                        TextField("模型名称", text: $draft.model)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("localModelCustom")
                    } footer: {
                        Text("兼容 OpenAI 的 /chat/completions 接口。")
                    }
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
