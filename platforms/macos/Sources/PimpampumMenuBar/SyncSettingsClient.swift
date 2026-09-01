import Foundation

struct SyncSettingsClient: SyncSettingsReading {
  static let supportedSchemaVersion = 1
  let receiptURL: URL
  let tokenURL: URL
  var fileReader: any OverviewFileReading = LocalOverviewFileReader()
  var transport: any OverviewTransport = URLSessionOverviewTransport()

  func fetch() async throws -> SyncSettings { try await request("GET", "", nil) }
  func configure(directory: String, deviceId: String) async throws -> SyncSettings {
    try await request("PUT", "", ["directory": directory, "deviceId": deviceId])
  }
  func reconcile() async throws -> SyncSettings { try await request("POST", "/reconcile", nil) }
  func pause() async throws -> SyncSettings { try await request("POST", "/pause", nil) }
  func resume() async throws -> SyncSettings { try await request("POST", "/resume", nil) }
  func forget() async throws -> SyncSettings { try await request("DELETE", "", nil) }

  private func request(_ method: String, _ suffix: String, _ body: [String: String]?) async throws
    -> SyncSettings
  {
    let configuration = try loadConfiguration()
    var request = URLRequest(
      url: configuration.baseURL.appending(path: "api/v1/settings/sync\(suffix)")
    )
    request.httpMethod = method
    request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.data(for: request)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw SyncSettingsClientError.transportFailure
    }
    guard response.statusCode != 401 else { throw SyncSettingsClientError.unauthorized }
    guard response.statusCode == 200 else {
      throw SyncSettingsClientError.serverStatus(
        response.statusCode,
        Self.serverMessage(from: data, redacting: configuration.token)
      )
    }
    return try Self.decodeSettings(data, rejecting: configuration.token)
  }

  private func loadConfiguration() throws -> SyncClientConfiguration {
    do {
      let configuration = try AuthenticatedDaemonConfigurationLoader(
        receiptURL: receiptURL,
        tokenURL: tokenURL,
        fileReader: fileReader
      ).load()
      return SyncClientConfiguration(baseURL: configuration.baseURL, token: configuration.token)
    } catch let error as AuthenticatedDaemonConfigurationError {
      throw Self.mapConfigurationError(error)
    }
  }

  private static func mapConfigurationError(_ error: AuthenticatedDaemonConfigurationError)
    -> SyncSettingsClientError
  {
    switch error {
    case .unreadableReceipt: .unreadableReceipt
    case .incompatibleReceiptSchema(let version): .incompatibleReceiptSchema(version)
    case .invalidBaseURL: .invalidBaseURL
    case .unreadableToken: .unreadableToken
    case .invalidToken: .invalidToken
    }
  }

  private static func decodeSettings(_ data: Data, rejecting token: String) throws -> SyncSettings {
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == ["data", "meta"],
      let metadata = root["meta"] as? [String: Any],
      Set(metadata.keys) == ["schemaVersion"],
      let payload = root["data"] as? [String: Any],
      Set(payload.keys) == [
        "enabled", "paused", "state", "directory", "deviceId", "lastAttemptAt",
        "lastImportAt", "lastExportAt", "pendingSnapshotCount", "conflictCount", "error",
        "blockedSnapshot",
      ],
      Self.hasBlockedSnapshotShape(payload["blockedSnapshot"])
    else { throw SyncSettingsClientError.invalidPayload }
    let envelope: SyncEnvelope
    do {
      envelope = try decoder().decode(SyncEnvelope.self, from: data)
    } catch {
      throw SyncSettingsClientError.invalidPayload
    }
    guard envelope.meta.schemaVersion == Self.supportedSchemaVersion else {
      throw SyncSettingsClientError.incompatibleResponseSchema(envelope.meta.schemaVersion)
    }
    guard Self.isValid(envelope.data), !Self.mentions(token, in: envelope.data) else {
      throw SyncSettingsClientError.invalidPayload
    }
    return envelope.data
  }

  /// `blockedSnapshot` is either null or exactly `{ path, reason }`; the nested object is held to
  /// the same strict key set as the envelope.
  private static func hasBlockedSnapshotShape(_ value: Any?) -> Bool {
    if value is NSNull { return true }
    guard let object = value as? [String: Any] else { return false }
    return Set(object.keys) == ["path", "reason"]
  }

  /// The daemon never echoes its own token, so a payload that does is not the daemon's.
  private static func mentions(_ token: String, in settings: SyncSettings) -> Bool {
    if settings.error?.contains(token) == true { return true }
    guard let blocked = settings.blockedSnapshot else { return false }
    return blocked.path.contains(token) || blocked.reason.contains(token)
  }

  static func isValid(_ settings: SyncSettings) -> Bool {
    guard settings.pendingSnapshotCount >= 0, settings.conflictCount >= 0 else { return false }
    guard settings.enabled == (settings.directory != nil && settings.deviceId != nil) else {
      return false
    }
    if !settings.enabled {
      return settings.state == .disabled && !settings.paused && settings.blockedSnapshot == nil
    }
    guard let directory = settings.directory, isSafeAbsolutePath(directory),
      let deviceId = settings.deviceId,
      deviceId.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression)
        != nil
    else { return false }
    if let error = settings.error, !isBoundedText(error) { return false }
    if let blocked = settings.blockedSnapshot,
      !isBoundedText(blocked.path) || !isBoundedText(blocked.reason)
    {
      return false
    }
    if settings.paused { return settings.state == .paused }
    guard settings.state != .disabled && settings.state != .paused else { return false }
    return true
  }

  /// One line of user-visible text from the daemon: present, bounded, and free of control
  /// characters that could break the panel or hide part of the message.
  private static func isBoundedText(_ value: String) -> Bool {
    !value.isEmpty && value.count <= 500
      && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
  }

  private static func isSafeAbsolutePath(_ path: String) -> Bool {
    !path.isEmpty && !path.contains("\0") && NSString(string: path).isAbsolutePath
  }

  private static func serverMessage(from data: Data, redacting token: String) -> String? {
    guard
      let envelope = try? JSONDecoder().decode(SyncServerErrorEnvelope.self, from: data),
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

private struct SyncClientConfiguration {
  let baseURL: URL
  let token: String
}

private struct SyncEnvelope: Decodable {
  let data: SyncSettings
  let meta: SyncMetadata
}

private struct SyncMetadata: Decodable { let schemaVersion: Int }

private struct SyncServerErrorEnvelope: Decodable {
  struct ServerError: Decodable {
    let message: String?
  }

  let error: ServerError
}
