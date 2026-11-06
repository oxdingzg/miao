import SwiftUI

@main @MainActor
struct MiaoApp: App {
    @UIApplicationDelegateAdaptor(MiaoApplicationDelegate.self) private var delegate
    @State private var model = AppModel()
    @State private var agent = LocalAgent()

    var body: some Scene {
        WindowGroup {
            // Two modes in one app: the phone on its own, and the owner's computer.
            TabView {
                LocalView(agent: agent)
                    .tabItem { Label("本机", systemImage: "iphone.gen3") }
                RemoteView(model: model)
                    .tabItem { Label("电脑", systemImage: "desktopcomputer") }
                    .onAppear { AppNotifications.shared.bind(model) }
            }
        }
    }
}
