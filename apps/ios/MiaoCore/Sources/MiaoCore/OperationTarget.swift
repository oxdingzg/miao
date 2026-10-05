import Foundation

public struct OperationTarget: Codable, Sendable, Equatable {
    public let hostID: String
    public let runtimeID: String
    public let sessionID: String?
    public let projectID: String?
    public init(session: SessionAddress) {
        hostID = session.hostID; runtimeID = session.runtimeID; sessionID = session.sessionID; projectID = nil
    }
    public init(hostID: String, runtimeID: String, projectID: String) {
        self.hostID = hostID; self.runtimeID = runtimeID; self.projectID = projectID; sessionID = nil
    }
}
