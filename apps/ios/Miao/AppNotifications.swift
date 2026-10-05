import UIKit
import UserNotifications
import Observation

@MainActor @Observable
final class AppNotifications {
    static let shared = AppNotifications()
    private(set) var failure = false
    private var token: Data?
    private weak var model: AppModel?
    private var pendingSignal: String?

    func bind(_ model: AppModel) {
        self.model = model
        if let token { model.receivePushToken(token) }
        if let pendingSignal { self.pendingSignal = nil; model.openNotification(pendingSignal) }
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

    func open(_ signalID: String) {
        guard signalID.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil else { return }
        if let model { model.openNotification(signalID) }
        else { pendingSignal = signalID }
    }
}

@MainActor
final class MiaoApplicationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let signalID = response.notification.request.content.userInfo["signalID"] as? String else { return }
        await MainActor.run { AppNotifications.shared.open(signalID) }
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        AppNotifications.shared.received(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        AppNotifications.shared.failed()
    }
}
