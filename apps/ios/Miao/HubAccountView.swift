import SwiftUI
import MiaoCore

@MainActor
struct HubAccountView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var origin = ""
    @State private var email = ""
    @State private var password = ""
    /// Whether the account was already signed in when this sheet opened. It is
    /// what tells a sign-in *this* sheet performed apart from one that was in
    /// effect all along — only the former should close the sheet.
    @State private var wasSignedIn = false
    @State private var confirmEnrollmentApproval = false

    var body: some View {
        NavigationStack {
            Form {
                Section("中继账号") {
                    if model.accountSignedIn {
                        Label("已登录", systemImage: "checkmark.circle")
                        Text(model.accountURL).font(.footnote).textSelection(.enabled)
                        Button("刷新电脑列表") { Task { await model.refreshDirectory() } }
                            .disabled(model.accountBusy)
                        Button("退出登录", role: .destructive) { password = ""; Task { await model.signOut() } }
                            .disabled(model.accountBusy)
                    } else {
                        TextField("HTTPS 中继地址", text: $origin).textContentType(.URL)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("hubOrigin")
                        TextField("邮箱", text: $email).textContentType(.username)
                            .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("hubEmail")
                        SecureField("密码", text: $password).textContentType(.password).accessibilityIdentifier("hubPassword")
                        Button("登录") {
                            let secret = password; password = ""
                            Task { await model.signIn(origin: origin, email: email, password: secret) }
                        }.disabled(model.accountBusy || origin.isEmpty || email.isEmpty || password.isEmpty)
                            .accessibilityIdentifier("hubSignIn")
                        Button("用 GitHub 登录") { model.accountURL = origin; Task { await model.signInWithOAuth(provider: "github") } }
                            .disabled(model.accountBusy)
                            .accessibilityIdentifier("hubOAuthGithub")
                        if model.accountBusy { ProgressView("正在登录…") }
                        Text("填写电脑配置的中继地址和账号。登录后可扫码配对，或让已信任的签名设备批准本设备注册。")
                            .font(.footnote).foregroundStyle(.secondary)
                        if model.revocationPending {
                            Button("重试退出登录") { Task { await model.signOut() } }.disabled(model.accountBusy)
                        }
                    }
                    if let error = model.accountError { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                if model.accountSignedIn {
                    Section {
                        DisclosureGroup {
                            Text("首次使用请先扫码配对，并在电脑设备管理中明确选择本设备作为账号签名设备。")
                                .font(.footnote).foregroundStyle(.secondary)
                            Toggle("允许本设备批准同账号的新设备", isOn: $model.enrollmentSignerConsent)
                                .accessibilityIdentifier("enrollmentSignerConsent")
                            Button("初始化签名设备") { Task { await model.initializeAccountSigner() } }
                                .disabled(model.enrollmentBusy || !model.enrollmentSignerConsent)
                                .accessibilityIdentifier("enrollmentRoot")
                            Button("连接我的电脑") { Task { await model.connectAccountDevices() } }
                            .disabled(model.accountBusy || model.enrollmentBusy)
                            .accessibilityIdentifier("connectAccountDevices")
                        Button("生成十分钟注册码") { Task { await model.createEnrollmentRequest() } }
                                .disabled(model.enrollmentBusy).accessibilityIdentifier("enrollmentBegin")
                            if !model.enrollmentRequest.isEmpty {
                                Text(model.enrollmentRequest).font(.caption.monospaced()).textSelection(.enabled)
                                    .accessibilityIdentifier("enrollmentRequest")
                                ShareLink("发送给已信任设备", item: model.enrollmentRequest)
                            }
                            TextField("收到的新设备注册码", text: $model.enrollmentIncoming, axis: .vertical)
                                .lineLimit(2...5).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .accessibilityIdentifier("enrollmentIncoming")
                            Text(model.incomingEnrollmentSummary).font(.caption.monospaced()).textSelection(.enabled)
                            Button("确认并批准新设备") { confirmEnrollmentApproval = true }
                                .disabled(model.enrollmentBusy || model.enrollmentIncoming.isEmpty)
                                .accessibilityIdentifier("enrollmentApprove")
                            if !model.enrollmentResponse.isEmpty {
                                Text(model.enrollmentResponse).font(.caption.monospaced()).textSelection(.enabled)
                                    .accessibilityIdentifier("enrollmentResponse")
                                ShareLink("返回批准结果", item: model.enrollmentResponse)
                            }
                            if !model.enrollmentSigner.isEmpty {
                                Text("本设备签名公钥").font(.caption)
                                Text(model.enrollmentSigner).font(.caption.monospaced()).textSelection(.enabled)
                                    .accessibilityIdentifier("enrollmentSigner")
                                ShareLink("发送签名公钥", item: model.enrollmentSigner)
                            }
                            TextField("已信任设备提供的批准结果", text: $model.enrollmentApproved, axis: .vertical)
                                .lineLimit(2...5).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .accessibilityIdentifier("enrollmentApproved")
                            TextField("已信任设备提供的签名公钥", text: $model.enrollmentPin)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .accessibilityIdentifier("enrollmentPin")
                            Toggle("结果和公钥直接来自我的已信任设备", isOn: $model.enrollmentIndependentPin)
                                .accessibilityIdentifier("enrollmentIndependentPin")
                            Button("完成注册并查找会话") { Task { await model.receiveEnrollmentApproval() } }
                                .disabled(model.enrollmentBusy || !model.enrollmentIndependentPin || model.enrollmentApproved.isEmpty || model.enrollmentPin.isEmpty)
                                .accessibilityIdentifier("enrollmentReceive")
                            if model.enrollmentBusy { ProgressView("正在验证设备授权…") }
                            if let error = model.enrollmentError { Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("enrollmentError") }
                            if model.enrollmentComplete { Text("设备注册完成").accessibilityIdentifier("enrollmentComplete") }
                        } label: {
                            Text("同账号设备注册").accessibilityIdentifier("enrollmentDisclosure")
                        }
                        .accessibilityIdentifier("enrollmentDisclosure")
                    }
                    Section("会话通知") {
                        Label(model.notificationsRegistered ? "通知设备已连接" : "通知未连接", systemImage: "bell")
                        if model.notificationsRevocationPending {
                            Button("重试关闭通知") { Task { await model.disableNotifications() } }
                                .disabled(model.notificationsBusy)
                        } else if model.notificationsWanted {
                            Button("关闭通知", role: .destructive) { Task { await model.disableNotifications() } }
                                .disabled(model.notificationsBusy)
                            if !model.notificationsRegistered {
                                Button("重试连接通知") { Task { await model.enableNotifications() } }
                                    .disabled(model.notificationsBusy)
                            }
                        } else {
                            Button("开启通知") { Task { await model.enableNotifications() } }
                                .disabled(model.notificationsBusy)
                                .accessibilityIdentifier("enableNotifications")
                        }
                        if model.notificationsBusy { ProgressView() }
                        if let error = model.notificationsError {
                            Text(error).font(.footnote).foregroundStyle(.secondary)
                        }
                        Text("通知只显示通用提醒，不包含会话内容。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("账号中的电脑") {
                        if model.discoveredHosts.isEmpty { Text("暂无已注册电脑").foregroundStyle(.secondary) }
                        ForEach(model.discoveredHosts) { host in
                            VStack(alignment: .leading, spacing: 4) {
                                Label(host.name, systemImage: "desktopcomputer")
                                Text(host.revokedAt != nil ? "已撤销" : host.online ? "在线" : "离线")
                                    .font(.caption).foregroundStyle(.secondary)
                                if !model.hosts.contains(where: { $0.host.target.hostID == host.hostID }) {
                                    Text("请在这台电脑上打开 /remote-control，扫码授权此设备")
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("中继账号")
            .confirmationDialog("批准此新设备使用电脑已明确确认的账号授权范围？", isPresented: $confirmEnrollmentApproval, titleVisibility: .visible) {
                Button("批准新设备") { Task { await model.approveEnrollmentRequest() } }
                Button("取消", role: .cancel) {}
            } message: { Text(model.incomingEnrollmentSummary) }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { password = ""; dismiss() } } }
            .onAppear {
                wasSignedIn = model.accountSignedIn
                origin = model.accountURL.isEmpty ? model.defaultAccountURL : model.accountURL
            }
            // A sign-in this sheet performed returns the person to the
            // workbench, rather than leaving them on a page whose only news is
            // "signed in". `accountBusy` is the signal rather than
            // `accountSignedIn`: the latter flips before `reload()` and
            // `refreshDirectory()` have run, so closing on it would show the
            // computer list for a moment and then change it.
            .onChange(of: model.accountBusy) { _, busy in
                guard !busy, model.accountSignedIn, !wasSignedIn else { return }
                wasSignedIn = true
                dismiss()
            }
            .onDisappear { password = "" }
        }
    }
}
