import SwiftUI

@main @MainActor
struct MiaoApp: App {
    @State private var model = AppModel()
    var body: some Scene {
        WindowGroup { RemoteView(model: model) }
    }
}
