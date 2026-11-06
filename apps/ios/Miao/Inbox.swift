import Foundation
import MiaoCore

/// One Session that waits on the phone: a tool approval, a question, or both.
/// The host does the scoping, so an entry here is always inside the grant.
struct InboxEntry: Identifiable, Sendable, Equatable {
    let sessionID: String
    let title: String
    let projectID: String
    let actions: [String]
    let questions: [String]

    var id: String { sessionID }

    var count: Int { actions.count + questions.count }

    /// The one line the sidebar shows, preferring the approval because it names
    /// the command that is about to run.
    var summary: String {
        if let action = actions.first { return action }
        if let question = questions.first { return question }
        return "等待你的处理"
    }

    init?(_ value: JSONValue) {
        guard let sessionID = value["sessionID"]?.string,
              let title = value["title"]?.string,
              let projectID = value["projectID"]?.string
        else { return nil }
        self.sessionID = sessionID
        self.title = title
        self.projectID = projectID
        self.actions = (value["permissions"]?.array ?? []).compactMap { $0["action"]?.string }
        self.questions = (value["questions"]?.array ?? []).compactMap { $0["text"]?.string }
    }
}

@MainActor
extension HostClient {
    /// Asks once for every Session in scope rather than polling each one.
    func loadInbox() async {
        guard ready else { return }
        do {
            let value = try await request(.pendingList)
            guard let data = value["data"]?.array else { throw RemoteConnectionError.protocolIncompatible }
            let entries = data.compactMap(InboxEntry.init)
            guard entries.count == data.count else { throw RemoteConnectionError.protocolIncompatible }
            inbox = entries
            inboxError = nil
        } catch {
            inboxError = userMessage(error)
        }
    }
}
