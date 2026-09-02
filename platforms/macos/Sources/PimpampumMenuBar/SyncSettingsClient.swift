import Foundation

struct SyncSettingsClient: SyncSettingsReading {
  static let supportedSchemaVersion = 1
  let receiptURL: URL
  let tokenURL: URL
  var fileReader: any OverviewFileReading = LocalOverviewFileReader()
  var transport: any OverviewTransport = URLSessionOverviewTransport()

  private var client: DaemonClient {
    DaemonClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: fileReader,
      transport: transport
    )
  }

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
    let encoded = try body.map { try JSONEncoder().encode($0) }
    let response: DaemonResponse
    do {
      response = try await client.send(
        method: method,
        path: "api/v1/settings/sync\(suffix)",
        jsonBody: encoded
      )
    } catch let failure as DaemonClientFailure {
      throw Self.map(failure)
    }
    return try Self.decodeSettings(response.data, rejecting: response.token)
  }

  private static func map(_ failure: DaemonClientFailure) -> SyncSettingsClientError {
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
      envelope = try DaemonClient.decoder().decode(SyncEnvelope.self, from: data)
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
    guard let directory = settings.directory, DaemonClient.isSafeAbsolutePath(directory),
      let deviceId = settings.deviceId,
      deviceId.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression)
        != nil
    else { return false }
    if let error = settings.error, !DaemonClient.isBoundedText(error) { return false }
    if let blocked = settings.blockedSnapshot,
      !DaemonClient.isBoundedText(blocked.path) || !DaemonClient.isBoundedText(blocked.reason)
    {
      return false
    }
    if settings.paused { return settings.state == .paused }
    guard settings.state != .disabled && settings.state != .paused else { return false }
    return true
  }

}

private struct SyncEnvelope: Decodable {
  let data: SyncSettings
  let meta: SyncMetadata
}

private struct SyncMetadata: Decodable { let schemaVersion: Int }
