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
      "Pimpampum's installation receipt could not be read. Run pimpampum install."
    case .incompatibleReceiptSchema(let version):
      "The installed Pimpampum receipt uses unsupported schema version \(version)."
    case .invalidBaseURL:
      "Pimpampum's configured URL must be an authenticated loopback HTTP endpoint."
    case .unreadableToken:
      "Pimpampum's local token file could not be read. Run pimpampum install."
    case .invalidToken:
      "Pimpampum's local token is invalid. Run pimpampum install to repair it."
    case .unauthorized:
      "Pimpampum rejected the local token. Run pimpampum install to reconcile it."
    case .incompatibleResponseSchema(let version):
      "Pimpampum returned unsupported backup settings schema version \(version)."
    case .serverStatus(let status, let message):
      message ?? "Pimpampum returned HTTP status \(status)."
    case .invalidPayload:
      "Pimpampum returned an invalid backup settings response."
    case .transportFailure:
      "Pimpampum could not be reached. Check that the daemon is running."
    }
  }
}

struct BackupSettingsClient: BackupSettingsReading {
  static let supportedSchemaVersion = 1

  private let receiptURL: URL
  private let tokenURL: URL
  private let fileReader: any OverviewFileReading
  private let transport: any OverviewTransport

  init(
    receiptURL: URL,
    tokenURL: URL,
    fileReader: any OverviewFileReading = LocalOverviewFileReader(),
    transport: any OverviewTransport = URLSessionOverviewTransport()
  ) {
    self.receiptURL = receiptURL
    self.tokenURL = tokenURL
    self.fileReader = fileReader
    self.transport = transport
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
    let configuration = try loadConfiguration()
    let endpoint = configuration.baseURL.appending(path: "api/v1/settings/backup\(suffix)")
    var request = URLRequest(url: endpoint)
    request.httpMethod = method
    request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let directory {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(ConfigureBackupRequest(directory: directory))
    }

    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.data(for: request)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw BackupSettingsClientError.transportFailure
    }

    guard response.statusCode != 401 else { throw BackupSettingsClientError.unauthorized }
    guard response.statusCode == 200 else {
      throw BackupSettingsClientError.serverStatus(
        response.statusCode,
        Self.serverMessage(from: data, redacting: configuration.token)
      )
    }
    return try Self.decodeSettings(data, rejecting: configuration.token)
  }

  private func loadConfiguration() throws -> ClientConfiguration {
    do {
      let configuration = try AuthenticatedDaemonConfigurationLoader(
        receiptURL: receiptURL,
        tokenURL: tokenURL,
        fileReader: fileReader
      ).load()
      return ClientConfiguration(baseURL: configuration.baseURL, token: configuration.token)
    } catch let error as AuthenticatedDaemonConfigurationError {
      throw Self.mapConfigurationError(error)
    }
  }

  private static func mapConfigurationError(_ error: AuthenticatedDaemonConfigurationError)
    -> BackupSettingsClientError
  {
    switch error {
    case .unreadableReceipt: .unreadableReceipt
    case .incompatibleReceiptSchema(let version): .incompatibleReceiptSchema(version)
    case .invalidBaseURL: .invalidBaseURL
    case .unreadableToken: .unreadableToken
    case .invalidToken: .invalidToken
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
      envelope = try decoder().decode(BackupSettingsEnvelope.self, from: data)
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

  private static func isValid(_ settings: BackupSettings) -> Bool {
    guard settings.enabled == (settings.state != .disabled) else { return false }
    if settings.enabled {
      guard
        let directory = settings.directory, isSafeAbsolutePath(directory),
        let snapshotPath = settings.snapshotPath, isSafeAbsolutePath(snapshotPath)
      else { return false }
    } else if settings.directory != nil || settings.snapshotPath != nil || settings.error != nil {
      return false
    }
    if let error = settings.error,
      error.isEmpty || error.count > 500 || error.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    {
      return false
    }
    return true
  }

  private static func isSafeAbsolutePath(_ path: String) -> Bool {
    !path.isEmpty && !path.contains("\0") && NSString(string: path).isAbsolutePath
  }

  private static func serverMessage(from data: Data, redacting token: String) -> String? {
    guard
      let envelope = try? JSONDecoder().decode(ServerErrorEnvelope.self, from: data),
      let message = envelope.error.message
    else { return nil }
    let redacted = message.replacingOccurrences(of: token, with: "[redacted]")
    let sanitized = redacted.unicodeScalars
      .filter { !CharacterSet.controlCharacters.contains($0) }
      .prefix(500)
    let value = String(String.UnicodeScalarView(sanitized))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  private static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let value = try container.decode(String.self)
      let fractional = ISO8601DateFormatter()
      fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = fractional.date(from: value) { return date }
      let standard = ISO8601DateFormatter()
      standard.formatOptions = [.withInternetDateTime]
      if let date = standard.date(from: value) { return date }
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Expected an ISO 8601 timestamp"
      )
    }
    return decoder
  }
}

private struct ClientConfiguration {
  let baseURL: URL
  let token: String
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

private struct ServerErrorEnvelope: Decodable {
  struct ServerError: Decodable {
    let message: String?
  }

  let error: ServerError
}
