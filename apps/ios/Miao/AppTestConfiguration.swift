import Foundation

/// Isolated simulator integration tests only. Device and Release builds always require TLS.
enum AppTestConfiguration {
    static var runID: String? {
        #if DEBUG && targetEnvironment(simulator)
        guard let value = ProcessInfo.processInfo.environment["MIAO_UI_TEST_RUN"], UUID(uuidString: value) != nil else { return nil }
        return value
        #else
        return nil
        #endif
    }
    static var allowLoopbackHTTP: Bool { runID != nil }
    static var requiresAccount: Bool { runID != nil && ProcessInfo.processInfo.environment["MIAO_UI_TEST_HUB_ACCOUNT"] == "1" }
    static var allowLegacyTransport: Bool { allowLoopbackHTTP && !requiresAccount }
    static var invitation: String? {
        #if DEBUG && targetEnvironment(simulator)
        return runID == nil ? nil : ProcessInfo.processInfo.environment["MIAO_UI_TEST_INVITATION"]
        #else
        return nil
        #endif
    }
}
