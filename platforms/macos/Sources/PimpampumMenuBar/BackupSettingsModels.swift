import Foundation

// The cases and `label` of `BackupHealthState` are generated into `StateVocabulary.swift` from
// the one table the Omarchy plugin shares; the panel's symbol choice stays here.
extension BackupHealthState {
  var symbolName: String {
    switch self {
    case .disabled: "externaldrive"
    case .pending: "arrow.triangle.2.circlepath"
    case .healthy: "checkmark.circle.fill"
    case .error: "exclamationmark.triangle.fill"
    }
  }
}

struct BackupSettings: Codable, Equatable, Sendable {
  let enabled: Bool
  let directory: String?
  let snapshotPath: String?
  let state: BackupHealthState
  let lastAttemptAt: Date?
  let lastSuccessAt: Date?
  let error: String?

  /// The third valid shape (M-C6): the daemon could not read its persisted backup settings, so
  /// automatic backup is off with no destination and `error` says why. The panel shows that line
  /// under "Backup needs attention"; choosing a folder rewrites the file and repairs it.
  var unreadableSettingsMessage: String? {
    !enabled && state == .error ? error : nil
  }
}

enum BackupSettingsActivity: Equatable, Sendable {
  case idle
  case loading
  case configuring
  case retrying
  case disabling

  var isBusy: Bool { self != .idle }
}
