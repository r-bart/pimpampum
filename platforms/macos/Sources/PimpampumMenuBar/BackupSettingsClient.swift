import Foundation

protocol BackupSettingsReading: Sendable {
  func fetchBackupSettings() async throws -> BackupSettings
  func configureBackup(directory: String) async throws -> BackupSettings
  func retryBackup() async throws -> BackupSettings
  func disableBackup() async throws -> BackupSettings
}

enum BackupSettingsClientError: Error, Equatable, LocalizedError, Sendable {
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
      "\(PimpampumBrand.displayName) returned unsupported backup settings schema version \(version)."
    case .serverStatus(let status, let message):
      message ?? "\(PimpampumBrand.displayName) returned HTTP status \(status)."
    case .invalidPayload:
      "\(PimpampumBrand.displayName) returned an invalid backup settings response."
    case .transportFailure:
      "\(PimpampumBrand.displayName) could not be reached. Check that the daemon is running."
    }
  }
}

struct BackupSettingsClient: BackupSettingsReading {
  static let supportedSchemaVersion = 1

  private let client: DaemonClient

  init(
    receiptURL: URL,
    tokenURL: URL,
    fileReader: any OverviewFileReading = LocalOverviewFileReader(),
    transport: any OverviewTransport = URLSessionOverviewTransport()
  ) {
    client = DaemonClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: fileReader,
      transport: transport
    )
  }

  func fetchBackupSettings() async throws -> BackupSettings {
    try await request(method: "GET", suffix: "", directory: nil)
  }

  func configureBackup(directory: String) async throws -> BackupSettings {
    try await request(method: "PUT", suffix: "", directory: directory)
  }

  func retryBackup() async throws -> BackupSettings {
    try await request(method: "POST", suffix: "/retry", directory: nil)
  }

  func disableBackup() async throws -> BackupSettings {
    try await request(method: "DELETE", suffix: "", directory: nil)
  }

  private func request(method: String, suffix: String, directory: String?) async throws
    -> BackupSettings
  {
    let body = try directory.map {
      try JSONEncoder().encode(ConfigureBackupRequest(directory: $0))
    }
    let response: DaemonResponse
    do {
      response = try await client.send(
        method: method,
        path: "api/v1/settings/backup\(suffix)",
        jsonBody: body
      )
    } catch let failure as DaemonClientFailure {
      throw Self.map(failure)
    }
    return try Self.decodeSettings(response.data, rejecting: response.token)
  }

  private static func map(_ failure: DaemonClientFailure) -> BackupSettingsClientError {
    switch failure {
    case .configuration(.unreadableReceipt): .unreadableReceipt
    case .configuration(.incompatibleReceiptSchema(let version)):
      .incompatibleReceiptSchema(version)
    case .configuration(.invalidBaseURL): .invalidBaseURL
    case .configuration(.unreadableToken): .unreadableToken
    case .configuration(.invalidToken): .invalidToken
    case .transport: .transportFailure
    case .unauthorized: .unauthorized
    case .serverStatus(let status, let message): .serverStatus(status, message)
    }
  }

  private static func decodeSettings(_ data: Data, rejecting token: String) throws -> BackupSettings {
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == ["data", "meta"],
      let metadata = root["meta"] as? [String: Any],
      Set(metadata.keys) == ["schemaVersion"],
      let payload = root["data"] as? [String: Any],
      Set(payload.keys)
        == [
          "enabled", "directory", "snapshotPath", "state", "lastAttemptAt", "lastSuccessAt",
          "error",
        ]
    else {
      throw BackupSettingsClientError.invalidPayload
    }

    let envelope: BackupSettingsEnvelope
    do {
      envelope = try DaemonClient.decoder().decode(BackupSettingsEnvelope.self, from: data)
    } catch {
      throw BackupSettingsClientError.invalidPayload
    }
    guard envelope.meta.schemaVersion == supportedSchemaVersion else {
      throw BackupSettingsClientError.incompatibleResponseSchema(envelope.meta.schemaVersion)
    }
    guard isValid(envelope.data), !(envelope.data.error?.contains(token) ?? false) else {
      throw BackupSettingsClientError.invalidPayload
    }
    return envelope.data
  }

  /// The three shapes `automaticBackupStatusSchema` admits: enabled with a destination, disabled
  /// with nothing, and `error` without a destination when the daemon could not read its settings
  /// file (M-C6). The last one used to be rejected here, so a corrupt file showed as "invalid
  /// payload" instead of the message that names the repair.
  private static func isValid(_ settings: BackupSettings) -> Bool {
    if let error = settings.error, !DaemonClient.isBoundedText(error) { return false }
    if settings.enabled {
      guard settings.state != .disabled,
        let directory = settings.directory, DaemonClient.isSafeAbsolutePath(directory),
        let snapshotPath = settings.snapshotPath, DaemonClient.isSafeAbsolutePath(snapshotPath)
      else { return false }
      return true
    }
    guard settings.directory == nil, settings.snapshotPath == nil else { return false }
    switch settings.state {
    case .disabled: return settings.error == nil
    case .error: return settings.error != nil
    case .pending, .healthy: return false
    }
  }

}

private struct ConfigureBackupRequest: Encodable {
  let directory: String
}

private struct BackupSettingsEnvelope: Decodable {
  let meta: BackupSettingsMetadata
  let data: BackupSettings
}

private struct BackupSettingsMetadata: Decodable {
  let schemaVersion: Int
}
