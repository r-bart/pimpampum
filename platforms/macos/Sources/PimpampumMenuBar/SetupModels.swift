import Foundation

let setupSchemaVersion = 1

enum SetupAgentID: String, Codable, CaseIterable, Hashable, Sendable {
  case codex
  case claudeCode = "claude-code"

  var displayName: String {
    switch self {
    case .codex: "Codex"
    case .claudeCode: "Claude Code"
    }
  }
}

struct SetupAgentSelection: Identifiable, Equatable, Sendable {
  let id: SetupAgentID
  let detected: Bool
  let supported: Bool
  var selected: Bool

  var selectedByDefault: Bool { detected && supported }
}

// The cases and `label` of `SetupComponentState` are generated into `StateVocabulary.swift`
// from the one table the Omarchy plugin shares; only the setup screen's own decisions live here.
extension SetupComponentState {
  var accessibilityLabel: String { label }

  /// Whether this state needs the user's attention. The background service is machinery: the setup
  /// screen lists the agents the user chose and only surfaces the service when it went wrong.
  var needsAttention: Bool {
    switch self {
    case .connected, .connecting, .newSessionRequired: false
    case .notInstalled, .notConnected, .needsRepair, .configurationConflict, .unsupportedVersion,
      .unavailable:
      true
    }
  }
}

struct SetupServicePresentation: Equatable, Sendable {
  var state: SetupComponentState
  var installed: Bool
  var running: Bool
  var verified: Bool
}

struct SetupAgentPresentation: Identifiable, Equatable, Sendable {
  let id: SetupAgentID
  var state: SetupComponentState
  var configured: Bool
  var available: Bool
  var newSessionRequired: Bool
  var error: String?
}

struct SetupChange: Codable, Equatable, Sendable {
  let kind: String
  let summary: String
  let path: String?
}

struct SetupConflict: Codable, Equatable, Sendable {
  let connectorId: SetupAgentID
  let comparison: String
}

struct SetupPlan: Codable, Equatable, Sendable {
  let operationId: String
  let revision: String
  let selectedConnectors: [SetupAgentID]
  let changes: [SetupChange]
  let conflicts: [SetupConflict]
  let requiresConfirmation: Bool
}

enum SetupProgressStatus: String, Codable, Equatable, Sendable {
  case started
  case completed
  case failed
}

struct SetupProgressEvent: Codable, Equatable, Hashable, Sendable {
  let schemaVersion: Int
  let operationId: String
  let phase: String
  let status: SetupProgressStatus
  let occurredAt: String
  let connectorId: SetupAgentID?
  let diagnostic: String?
}

enum SetupConflictDecision: Equatable, Sendable {
  case keep
  case replace
}

struct SetupServiceResult: Codable, Equatable, Sendable {
  let installed: Bool
  let running: Bool
  let verified: Bool
}

struct SetupConnectorResult: Codable, Equatable, Sendable {
  let id: SetupAgentID
  let configured: Bool
  let available: Bool
  let newSessionRequired: Bool
  let state: String
  let error: String?
}

enum SetupCompletionStatus: String, Codable, Equatable, Sendable {
  case complete
  case partial
  case conflict
  case failed
}

enum SetupNextAction: String, Codable, Equatable, Sendable {
  case done
  case retry
  case newSession = "new-session"
  case resolveConflict = "resolve-conflict"
  case recoverLoginItem = "recover-login-item"
}

struct SetupResult: Codable, Equatable, Sendable {
  let status: SetupCompletionStatus
  let service: SetupServiceResult
  let connectors: [SetupConnectorResult]
  let nextAction: SetupNextAction
}

enum SetupJournalStatus: String, Codable, Equatable, Sendable {
  case running
  case complete
  case partial
  case conflict
  case failed
}

struct SetupJournal: Codable, Equatable, Sendable {
  let schemaVersion: Int
  let operationId: String
  let revision: String
  let phase: String
  let selectedConnectors: [SetupAgentID]
  let completedPhases: [String]
  let diagnostics: [String]
  let service: SetupServiceResult
  let connectors: [SetupConnectorResult]
  let loginItem: String
  let status: SetupJournalStatus
  let updatedAt: String
}

enum SetupWireEvent: Equatable, Sendable {
  case plan(SetupPlan)
  case progress(SetupProgressEvent)
  case result(SetupResult)
  case journal(SetupJournal?)
}

enum SetupActivity: Equatable, Sendable {
  case idle
  case detecting
  case planning
  case applying
  case resuming

  var isBusy: Bool { self != .idle }
  var hasBegunMutation: Bool { self == .applying || self == .resuming }
}

enum SetupClientError: Error, Equatable {
  case unavailable
  case invalidResponse
  case incompatibleSchema
  case responseTooLarge
  case commandFailed(String)
  case cancelled

  var message: String {
    switch self {
    case .unavailable: "The packaged setup runtime is unavailable. Reinstall Pimpampum and retry."
    case .invalidResponse: "Pimpampum returned an invalid setup response."
    case .incompatibleSchema: "This app and the packaged setup runtime are incompatible."
    case .responseTooLarge: "Pimpampum returned more setup detail than the app can safely display."
    case .commandFailed(let message): message
    case .cancelled: "Setup review was cancelled before anything changed."
    }
  }
}
