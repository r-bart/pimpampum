import Foundation

enum SyncHealthState: String, Codable, Sendable {
  case disabled, paused, pending, importing, exporting, healthy, unavailable, error, conflict

  var label: String {
    switch self {
    case .disabled: "Not configured"
    case .paused: "Synchronization paused"
    case .pending: "Changes pending"
    case .importing: "Importing changes…"
    case .exporting: "Exporting changes…"
    case .healthy: "Up to date"
    case .unavailable: "Shared folder unavailable"
    case .error: "Synchronization needs attention"
    case .conflict: "Conflict requires attention"
    }
  }
}

/// A shared snapshot file the daemon refused. `path` is relative to the shared folder, so the
/// status names the file without repeating the absolute folder.
struct SyncBlockedSnapshot: Codable, Equatable, Sendable {
  let path: String
  let reason: String
}

struct SyncSettings: Codable, Equatable, Sendable {
  let enabled: Bool
  let paused: Bool
  let state: SyncHealthState
  let directory: String?
  let deviceId: String?
  let lastAttemptAt: Date?
  let lastImportAt: Date?
  let lastExportAt: Date?
  let pendingSnapshotCount: Int
  let conflictCount: Int
  let error: String?
  let blockedSnapshot: SyncBlockedSnapshot?
}

/// Copy decisions for the synchronization panel, kept out of the SwiftUI body so the gate
/// measures them.
enum SyncSettingsPresentation {
  /// One line naming the refused file and why, or nothing when every snapshot was accepted.
  static func blockedSnapshotLine(_ settings: SyncSettings) -> String? {
    guard let blocked = settings.blockedSnapshot else { return nil }
    return "Blocked snapshot \(blocked.path): \(blocked.reason)"
  }
}

protocol SyncSettingsReading: Sendable {
  func fetch() async throws -> SyncSettings
  func configure(directory: String, deviceId: String) async throws -> SyncSettings
  func reconcile() async throws -> SyncSettings
  func pause() async throws -> SyncSettings
  func resume() async throws -> SyncSettings
  func forget() async throws -> SyncSettings
}

enum SyncSettingsClientError: Error, Equatable, LocalizedError, Sendable {
  case unreadableReceipt
  case incompatibleReceiptSchema(Int)
  case invalidBaseURL
  case unreadableToken
  case invalidToken
  case unauthorized
  case incompatibleResponseSchema(Int)
  case serverStatus(Int, String?)
  case invalidPayload
  case transportFailure

  var errorDescription: String? {
    switch self {
    case .unreadableReceipt:
      "\(PimpampumBrand.displayName)'s installation receipt could not be read. Run pimpampum install."
    case .incompatibleReceiptSchema(let version):
      "The installed \(PimpampumBrand.displayName) receipt uses unsupported schema version \(version)."
    case .invalidBaseURL:
      "\(PimpampumBrand.displayName)'s configured URL must be an authenticated loopback HTTP endpoint."
    case .unreadableToken:
      "\(PimpampumBrand.displayName)'s local token file could not be read. Run pimpampum install."
    case .invalidToken:
      "\(PimpampumBrand.displayName)'s local token is invalid. Run pimpampum install to repair it."
    case .unauthorized:
      "\(PimpampumBrand.displayName) rejected the local token. Run pimpampum install to reconcile it."
    case .incompatibleResponseSchema(let version):
      "\(PimpampumBrand.displayName) returned unsupported synchronization schema version \(version)."
    case .serverStatus(let status, let message):
      message ?? "\(PimpampumBrand.displayName) returned HTTP status \(status)."
    case .invalidPayload:
      "\(PimpampumBrand.displayName) returned an invalid synchronization response."
    case .transportFailure:
      "\(PimpampumBrand.displayName) could not be reached. Check that the daemon is running."
    }
  }
}
