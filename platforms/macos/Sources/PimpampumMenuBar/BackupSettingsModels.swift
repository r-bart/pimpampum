import Foundation

enum BackupHealthState: String, Codable, CaseIterable, Sendable {
  case disabled
  case pending
  case healthy
  case error

  var label: String {
    switch self {
    case .disabled: "Automatic backup is off"
    case .pending: "Backing up…"
    case .healthy: "Up to date"
    case .error: "Backup needs attention"
    }
  }

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
}

enum BackupSettingsActivity: Equatable, Sendable {
  case idle
  case loading
  case configuring
  case retrying
  case disabling

  var isBusy: Bool { self != .idle }
}
