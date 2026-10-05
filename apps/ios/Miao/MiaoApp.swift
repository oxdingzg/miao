import SwiftUI

@main @MainActor
struct MiaoApp: App {
    @UIApplicationDelegateAdaptor(MiaoApplicationDelegate.self) private var delegate
    @State private var model = AppModel()
    var body: some Scene {
        WindowGroup { RemoteView(model: model).onAppear { AppNotifications.shared.bind(model) } }
    }
}
