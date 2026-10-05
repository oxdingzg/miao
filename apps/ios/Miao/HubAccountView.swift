import SwiftUI
import MiaoCore

@MainActor
struct HubAccountView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var origin = ""
    @State private var email = ""
    @State private var password = ""

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
                        if model.accountBusy { ProgressView("正在登录…") }
                        Text("填写电脑配置的中继地址和账号。登录后仍需扫码，并在电脑上批准这台设备。")
                            .font(.footnote).foregroundStyle(.secondary)
                        if model.revocationPending {
                            Button("重试退出登录") { Task { await model.signOut() } }.disabled(model.accountBusy)
                        }
                    }
                    if let error = model.accountError { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                if model.accountSignedIn {
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
            .navigationTitle("中继账号")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { password = ""; dismiss() } } }
            .onAppear { origin = model.accountURL }
            .onDisappear { password = "" }
        }
    }
}
