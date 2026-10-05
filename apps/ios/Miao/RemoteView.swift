import SwiftUI
import MiaoCore

@MainActor
struct RemoteView: View {
    @Bindable var model: AppModel
    @Environment(\.scenePhase) private var phase
    @State private var sceneID = UUID()
    @State private var hostID: UUID?
    @State private var pairing = false
    @State private var invitation = ""
    @State private var attached: UUID?
    @State private var attachEpoch = 0

    var body: some View {
        NavigationSplitView {
            List(selection: $hostID) {
                Section("我的电脑") {
                    if model.hosts.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("在电脑的 /remote-control 中选择 App，扫码后即可接回会话。")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Button("连接电脑", systemImage: "qrcode.viewfinder") { pairing = true }
                                .buttonStyle(.borderedProminent)
                        }.padding(.vertical, 8)
                    }
                    ForEach(model.hosts) { record in
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(record.host.label)
                                Text(record.expired ? "授权已过期" : "已配对").font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "desktopcomputer") }.tag(record.id)
                    }
                }
                if !model.attempts.isEmpty {
                    Section("待核对的配对") {
                        Text("曾发起配对但未确认保存授权。请在电脑上检查设备接入状态后重新配对。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = model.error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("miao")
            .toolbar { Button("连接电脑", systemImage: "qrcode.viewfinder") { pairing = true } }
        } detail: {
            if let hostID, let client = model.clients[hostID] {
                NavigationStack { HostView(client: client, forget: { Task { await model.forget(hostID); self.hostID = nil } }) }
                    .id(hostID)
            } else {
                ContentUnavailableView {
                    Label("随时接回会话", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("在电脑上的 /remote-control 中选择 App，扫码并批准这台设备。")
                } actions: { Button("连接电脑") { pairing = true }.buttonStyle(.borderedProminent) }
            }
        }
        .task {
            await model.load()
            if let value = AppTestConfiguration.invitation { invitation = value; pairing = true }
            if hostID == nil { hostID = model.hosts.first?.id }
            await attach()
        }
        .onChange(of: hostID) { _, _ in Task { await attach() } }
        .onChange(of: model.hosts.map(\.id)) { _, ids in
            if hostID == nil { hostID = ids.first }
        }
        .onChange(of: phase) { _, value in
            model.scene(sceneID, phase: value)
            Task { if let attached { await model.clients[attached]?.scene(sceneID, phase: value) } }
        }
        .onDisappear {
            model.removeScene(sceneID)
            let previous = attached
            Task { if let previous { await model.clients[previous]?.removeScene(sceneID) } }
        }
        .onOpenURL { url in invitation = url.absoluteString; pairing = true }
        .sheet(isPresented: $pairing, onDismiss: { invitation = "" }) { PairingView(model: model, initialURI: $invitation) }
    }

    @MainActor private func attach() async {
        attachEpoch += 1
        let generation = attachEpoch
        let target = hostID
        let previous = attached
        attached = target
        if let previous, previous != target { await model.clients[previous]?.removeScene(sceneID) }
        guard attachEpoch == generation else { return }
        model.scene(sceneID, phase: phase)
        if let target { await model.clients[target]?.scene(sceneID, phase: phase) }
    }
}

@MainActor
private struct PairingView: View {
    @Bindable var model: AppModel
    @Binding var initialURI: String
    @Environment(\.dismiss) private var dismiss
    @State private var uri = ""
    @State private var label = UIDevice.current.userInterfaceIdiom == .pad ? "我的 iPad" : "我的 iPhone"
    @State private var scanning = false
    @State private var previousHosts = Set<UUID>()

    var body: some View {
        NavigationStack {
            Form {
                Section("设备名称") { TextField("这台设备的名称", text: $label).textContentType(.nickname) }
                Section {
                    Button("扫描电脑上的二维码", systemImage: "qrcode.viewfinder") { scanning = true }
                    TextField("粘贴 miao 配对链接", text: $uri, axis: .vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                        .accessibilityIdentifier("pairingURI")
                    Button("开始配对") { model.pair(uri.trimmingCharacters(in: .whitespacesAndNewlines), label: label); uri = "" }
                        .disabled(model.pairing != nil || uri.isEmpty || label.isEmpty || label.utf16.count > 128)
                } header: { Text("连接电脑") } footer: { Text("链接只用于一次配对。请核对电脑和手机显示的设备指纹，再在电脑上批准。") }
                if let progress = model.pairing {
                    Section { ProgressView(progress); if let fingerprint = model.fingerprint {
                        Text(fingerprint).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    }; Button("取消配对", role: .cancel) { model.cancelPairing() } }
                }
                if let error = model.error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("连接电脑")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { model.cancelPairing(); dismiss() } } }
            .onAppear { uri = initialURI; previousHosts = Set(model.hosts.map(\.id)) }
            .onChange(of: model.hosts.map(\.id)) { _, ids in
                if ids.contains(where: { !previousHosts.contains($0) }) { dismiss() }
            }
            .sheet(isPresented: $scanning) {
                ScannerView(scanned: { value in uri = value; scanning = false }, manual: { scanning = false })
            }
        }
    }
}

@MainActor
private struct HostView: View {
    @Bindable var client: HostClient
    let forget: () -> Void
    @State private var forgetConfirmation = false
    @State private var creating = false

    var body: some View {
        List {
            Section {
                Label(status, systemImage: client.ready ? "checkmark.circle.fill" : "network")
                    .foregroundStyle(client.ready ? .green : .secondary)
                if let error = client.error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            ForEach(client.lists.keys.sorted(), id: \.self) { project in
                Section(projectName(project)) {
                    ForEach(client.lists[project] ?? []) { session in
                        NavigationLink { SessionView(client: client, session: client.session(session)) } label: {
                            Label(session.title, systemImage: "bubble.left.and.text.bubble.right")
                        }
                    }
                    if client.next[project] != nil {
                        Button("更多会话") { Task { await client.refreshLists(more: project) } }.disabled(!client.ready)
                    }
                }
            }
            if !client.operations.filter({ [.prepared, .awaitingConfirmation, .outcomeUnknown].contains($0.status) }).isEmpty {
                Section("待核对操作") {
                    ForEach(client.operations.filter { [.prepared, .awaitingConfirmation, .outcomeUnknown].contains($0.status) }) { operation in
                        VStack(alignment: .leading) {
                            Text(operation.kind.rawValue)
                            Text("结果尚未确认；不会自动重新发送").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Button("核对操作结果") { Task { await client.reconcileOperations() } }.disabled(!client.ready)
                }
            }
        }
        .navigationTitle(client.record.host.label)
        .refreshable { await client.refreshLists() }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if client.record.grant.permissions.contains(.sessionCreate) {
                    Button("新会话", systemImage: "plus") { creating = true }.disabled(!client.ready)
                }
                Menu {
                    Button("刷新会话", systemImage: "arrow.clockwise") { Task { await client.refreshLists() } }
                    Button("从这台设备移除", systemImage: "trash", role: .destructive) { forgetConfirmation = true }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .confirmationDialog("从这台设备移除电脑？", isPresented: $forgetConfirmation, titleVisibility: .visible) {
            Button("移除", role: .destructive, action: forget)
        } message: { Text("本机缓存将被删除，电脑上的任务继续运行。要撤销授权，请在电脑的设备接入界面操作。") }
        .sheet(isPresented: $creating) { CreateSessionView(client: client) }
    }
    private var status: String {
        client.connectionDescription
    }
    private func projectName(_ id: String) -> String {
        if id.isEmpty { return "已授权会话" }
        return client.projects.first(where: { $0["id"]?.string == id })?["name"]?.string ?? "项目"
    }
}

@MainActor
private struct CreateSessionView: View {
    @Bindable var client: HostClient
    @Environment(\.dismiss) private var dismiss
    @State private var creating = false
    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(client.projects.enumerated()), id: \.offset) { _, project in
                    if let projectID = project["id"]?.string {
                        Section(project["name"]?.string ?? "项目") {
                            ForEach(Array((project["directories"]?.array ?? []).enumerated()), id: \.offset) { _, directory in
                                if let directoryID = directory["id"]?.string {
                                    Button(directory["name"]?.string ?? "目录") {
                                        creating = true
                                        Task {
                                            do {
                                                _ = try await client.mutate(.sessionCreate, kind: .sessionCreate,
                                                    target: OperationTarget(hostID: client.record.host.target.hostID,
                                                        runtimeID: client.record.host.target.runtimeID, projectID: projectID),
                                                    payload: .object(["directoryID": .string(directoryID)]))
                                                await client.refreshLists(); dismiss()
                                            } catch { client.error = userMessage(error) }
                                            creating = false
                                        }
                                    }.disabled(creating || !client.ready)
                                }
                            }
                        }
                    }
                }
                if let error = client.error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("选择工作目录")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
    }
}

@MainActor
private struct SessionView: View {
    @Bindable var client: HostClient
    @Bindable var session: RemoteSession
    @State private var speech = SpeechInput()
    @State private var diffPresented = false
    @State private var renamePresented = false
    @State private var menuPresented = false
    @State private var selectedAction: String?
    @State private var title = ""
    @State private var queue = false
    @FocusState private var composing: Bool
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                if !client.ready { Label("连接恢复后可继续操作，输入会保存在本机", systemImage: "wifi.slash").font(.footnote).foregroundStyle(.secondary) }
                if session.loading { ProgressView("正在同步会话…") }
                if session.timeline.revert != nil { Label("电脑上有待确认的回退操作", systemImage: "arrow.uturn.backward").font(.footnote) }
                ForEach(Array(session.timeline.messages.enumerated()), id: \.element.messageID) { _, message in
                    MessageView(message: message)
                }
                PendingView(client: client, session: session)
                if let error = session.error { Text(error).font(.footnote).foregroundStyle(.red) }
            }.padding()
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(session.timeline.title.isEmpty ? session.summary.title : session.timeline.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { composing = false; menuPresented = true } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("会话菜单")
                    .accessibilityIdentifier("sessionMenu").accessibilityValue(client.connectionDescription).disabled(!client.ready)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("完成") { composing = false }.accessibilityIdentifier("dismissKeyboard")
            }
        }
        .sheet(isPresented: $menuPresented, onDismiss: {
            let action = selectedAction
            selectedAction = nil
            if action == "rename" {
                title = session.timeline.title.isEmpty ? session.summary.title : session.timeline.title
                renamePresented = true
            }
            if action == "diff" { Task { await session.loadDiff(); diffPresented = session.diff != nil } }
        }) {
            NavigationStack {
                Form {
                    Button("查看文件变化") { selectedAction = "diff"; menuPresented = false }
                    if client.record.grant.permissions.contains(.sessionRename) {
                        Button("重命名") { selectedAction = "rename"; menuPresented = false }
                    }
                }
                .navigationTitle("会话操作")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { menuPresented = false } } }
            }
            .presentationDetents([.medium])
        }
        .onAppear { session.appear() }
        .onDisappear { speech.stop(); session.disappear() }
        .onChange(of: phase) { _, value in if value == .background { speech.stop(); composing = false } }
        .sheet(isPresented: $diffPresented) {
            NavigationStack { ScrollView { Text(session.diff?.formatted ?? "").font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding() }
                .navigationTitle("文件变化").toolbar { Button("关闭") { diffPresented = false } } }
        }
        .sheet(isPresented: $renamePresented) {
            RenameSessionView(initialTitle: title) { value in
                Task { _ = await session.command(.sessionRename, kind: .sessionRename, payload: .object(["title": .string(value)])) }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let error = speech.error { Text(error).font(.caption).foregroundStyle(.red) }
            if client.record.grant.permissions.contains(.prompt) {
                TextField("给 miao 的消息", text: Binding(get: { session.draft }, set: { session.edit($0) }), axis: .vertical)
                    .focused($composing)
                    .lineLimit(2...8).padding(10).background(.background, in: RoundedRectangle(cornerRadius: 12))
                    .disabled(speech.recording).accessibilityIdentifier("messageDraft")
                HStack {
                    Button(speech.recording ? "停止听写" : "语音输入", systemImage: speech.recording ? "stop.circle.fill" : "mic") {
                        if speech.recording || speech.requesting { speech.stop() }
                        else { Task { await speech.start(text: session.draft) { expected, value in
                            guard session.draft == expected else { return false }
                            session.edit(value); return true
                        } } }
                    }.disabled(speech.requesting)
                    Spacer()
                    Toggle("排队", isOn: $queue).toggleStyle(.button).font(.caption).accessibilityIdentifier("queueInput")
                    Button("发送", systemImage: "arrow.up") { speech.stop(); Task { await session.send(queue: queue) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!client.ready || client.sending(session.summary.id) || session.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.draft.utf16.count > 65_536)
                        .accessibilityIdentifier("sendMessage")
                }
            } else { Text("此设备拥有只读会话权限").font(.footnote).foregroundStyle(.secondary) }
        }.padding().background(.bar)
    }
}

private extension JSONValue { var messageID: String { self["id"]?.string ?? "" } }

@MainActor
private struct MessageView: View {
    let message: JSONValue
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(role, systemImage: message["type"]?.string == "user" ? "person.circle" : "sparkles")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let text = message["text"]?.string { Text(text).textSelection(.enabled) }
            if let summary = message["summary"]?.string { Text(summary).textSelection(.enabled) }
            ForEach(Array((message["content"]?.array ?? []).enumerated()), id: \.offset) { _, part in
                if part["type"]?.string == "reasoning" {
                    DisclosureGroup("思考过程") { Text(part["text"]?.string ?? part.formatted).font(.footnote).textSelection(.enabled) }
                } else if let text = part["text"]?.string { Text(text).textSelection(.enabled) }
                else {
                    DisclosureGroup(part["name"]?.string ?? part["type"]?.string ?? "操作详情") {
                        Text(part.formatted).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                }
            }
            if let command = message["command"]?.string { Text(command).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
            if let output = message["output"]?.string { Text(output).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
            if ["agent-switched", "model-switched"].contains(message["type"]?.string ?? "") {
                Text(message["agent"]?.string ?? message["model"]?.formatted ?? "").font(.footnote).textSelection(.enabled)
            }
            if let error = message["error"] { Text(error.formatted).font(.footnote).foregroundStyle(.red) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14).background(message["type"]?.string == "user" ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
    }
    private var role: String {
        switch message["type"]?.string { case "user": return "你"; case "assistant": return "miao"; case "shell": return "终端"; case "compaction": return "上下文整理"; default: return "会话记录" }
    }
}

@MainActor
private struct PendingView: View {
    @Bindable var client: HostClient
    @Bindable var session: RemoteSession
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let executionID = session.pending["execution"]?["executionID"]?.string,
               session.pending["execution"]?["type"]?.string == "running" {
                HStack { ProgressView(); Text("电脑正在执行"); Spacer()
                    if client.record.grant.permissions.contains(.interrupt) {
                        Button("停止", role: .destructive) { Task { _ = await session.command(.sessionInterrupt, kind: .interrupt, payload: .object(["executionID": .string(executionID)])) } }
                            .disabled(!client.ready || client.sending(session.summary.id))
                    }
                }
            }
            ForEach(Array((session.pending["permissions"]?.array ?? []).enumerated()), id: \.offset) { _, request in
                if let id = request["id"]?.string {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(request["action"]?.string ?? "权限请求").font(.headline)
                        Text((request["resources"]?.array ?? []).compactMap(\.string).joined(separator: "\n")).font(.footnote).textSelection(.enabled)
                        if client.record.grant.permissions.contains(.permissionReply) {
                            HStack { reply("允许一次", id: id, value: "once"); reply("拒绝", id: id, value: "reject") }
                                .disabled(!client.ready || client.sending(session.summary.id))
                        }
                    }.padding().background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            ForEach(Array((session.pending["questions"]?.array ?? []).enumerated()), id: \.offset) { _, request in
                if let id = request["id"]?.string { QuestionView(client: client, session: session, request: request).id(id) }
            }
            if let data = session.pending["inputs"]?["data"]?.array, !data.isEmpty {
                DisclosureGroup("待处理输入（\(data.count)）") {
                    ForEach(Array(data.enumerated()), id: \.offset) { _, input in Text(input["prompt"]?["text"]?.string ?? input.formatted).font(.footnote) }
                }
            }
        }
    }
    private func reply(_ title: String, id: String, value: String) -> some View {
        Button(title) { Task { _ = await session.command(.permissionReply, kind: .permissionReply, payload: .object(["requestID": .string(id), "reply": .string(value)])) } }.buttonStyle(.bordered)
    }
}

@MainActor
private struct QuestionView: View {
    @Bindable var client: HostClient
    @Bindable var session: RemoteSession
    let request: JSONValue
    @State private var selected: [Int: Set<String>] = [:]
    @State private var custom: [Int: String] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array((request["questions"]?.array ?? []).enumerated()), id: \.offset) { index, question in
                Text(question["question"]?.string ?? "问题").font(.headline)
                ForEach(Array((question["options"]?.array ?? []).enumerated()), id: \.offset) { _, option in
                    if let label = option["label"]?.string {
                        Button {
                            var values = selected[index] ?? []
                            if values.contains(label) { values.remove(label) }
                            else if question["multiSelect"]?.bool == true { values.insert(label) }
                            else { values = [label] }
                            selected[index] = values
                        } label: {
                            HStack(alignment: .top) { Image(systemName: selected[index]?.contains(label) == true ? "checkmark.circle.fill" : "circle")
                                VStack(alignment: .leading) { Text(label); if let description = option["description"]?.string { Text(description).font(.caption).foregroundStyle(.secondary) } }
                            }
                        }.buttonStyle(.plain)
                    }
                }
                if question["custom"]?.bool != false {
                    TextField("自定义回答", text: Binding(get: { custom[index] ?? "" }, set: { custom[index] = $0 }))
                }
            }
            if client.record.grant.permissions.contains(.questionReply), let id = request["id"]?.string {
                HStack {
                    Button("提交回答") {
                        let answers = (request["questions"]?.array ?? []).enumerated().map { index, question -> JSONValue in
                            let labels = (question["options"]?.array ?? []).compactMap { $0["label"]?.string }.filter { selected[index]?.contains($0) == true }
                            let text = (custom[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                            let values = text.isEmpty ? labels : question["multiSelect"]?.bool == true ? labels + [text] : [text]
                            return .array(values.map(JSONValue.string))
                        }
                        Task { _ = await session.command(.questionReply, kind: .questionReply, payload: .object(["requestID": .string(id), "answers": .array(answers)])) }
                    }.disabled(!answered)
                    Button("跳过", role: .cancel) { Task { _ = await session.command(.questionReply, kind: .questionReply, payload: .object(["requestID": .string(id), "reject": .bool(true)])) } }
                }.buttonStyle(.bordered).disabled(!client.ready || client.sending(session.summary.id))
            }
        }.padding().background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
    private var answered: Bool {
        let questions = request["questions"]?.array ?? []
        return !questions.isEmpty && questions.indices.allSatisfy { !(selected[$0] ?? []).isEmpty || !(custom[$0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
}

@MainActor
private struct RenameSessionView: View {
    @State private var value: String
    @Environment(\.dismiss) private var dismiss
    let save: (String) -> Void

    init(initialTitle: String, save: @escaping (String) -> Void) {
        _value = State(initialValue: initialTitle)
        self.save = save
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("会话名称", text: $value).accessibilityIdentifier("renameTitle")
                Button("清除会话名称") { value = "" }
                    .accessibilityIdentifier("clearRenameTitle").disabled(value.isEmpty)
            }
            .navigationTitle("重命名会话")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save(value); dismiss() }
                        .disabled(value.isEmpty || value.utf16.count > 256)
                }
            }
        }.presentationDetents([.medium])
    }
}
