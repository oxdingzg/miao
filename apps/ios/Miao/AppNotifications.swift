import UIKit
import UserNotifications
import Observation

@MainActor @Observable
final class AppNotifications {
    static let shared = AppNotifications()
    private(set) var failure = false
    private var token: Data?
    private weak var model: AppModel?

    func bind(_ model: AppModel) {
        self.model = model
        if let token { model.receivePushToken(token) }
    }

    func received(_ token: Data) {
        self.token = token
        failure = false
        model?.receivePushToken(token)
    }

    func failed() {
        token = nil
        failure = true
        model?.pushRegistrationFailed()
    }

    func forget() { token = nil }
}

@MainActor
final class MiaoApplicationDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        AppNotifications.shared.received(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        AppNotifications.shared.failed()
    }
}
