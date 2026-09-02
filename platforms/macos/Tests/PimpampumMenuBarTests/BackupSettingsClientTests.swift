import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
struct BackupSettingsClientTests {
  private let receiptURL = URL(fileURLWithPath: "/configuration/install-receipt.json")
  private let tokenURL = URL(fileURLWithPath: "/configuration/token")

  @Test
  func sendsEveryAuthenticatedOperationWithTheExpectedMethodPathAndBody() async throws {
    let recorder = RequestRecorder()
    let client = makeClient(data: payload(.healthy), recorder: recorder)

    _ = try await client.fetchBackupSettings()
    _ = try await client.configureBackup(directory: "/Users/example/iCloud Drive/Pimpampum")
    _ = try await client.retryBackup()
    _ = try await client.disableBackup()

    let requests = await recorder.requests
    #expect(requests.map(\.httpMethod) == ["GET", "PUT", "POST", "DELETE"])
    #expect(
      requests.map { $0.url?.path } == [
        "/api/v1/settings/backup",
        "/api/v1/settings/backup",
        "/api/v1/settings/backup/retry",
        "/api/v1/settings/backup",
      ])
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)" })
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Accept") == "application/json" })
    #expect(requests[0].httpBody == nil)
    #expect(requests[1].value(forHTTPHeaderField: "Content-Type") == "application/json")
    let body = try JSONDecoder().decode([String: String].self, from: requests[1].httpBody!)
    #expect(body == ["directory": "/Users/example/iCloud Drive/Pimpampum"])
  }

  @Test(arguments: [
    "http://127.0.0.1:7337",
    "http://localhost:7337/",
    "http://[::1]:7337",
  ])
  func acceptsSafeLoopbackReceipts(baseURL: String) async throws {
    #expect(try await makeClient(data: payload(.disabled), baseURL: baseURL).fetchBackupSettings().state == .disabled)
  }

  @Test(arguments: [
    "https://127.0.0.1:7337",
    "http://0.0.0.0:7337",
    "http://user@localhost:7337",
    "http://localhost:7337/nested",
    "http://localhost:7337?query=yes",
    "http:",
    "not a url",
  ])
  func rejectsUnsafeBaseURLs(baseURL: String) async {
    await #expect(throws: BackupSettingsClientError.invalidBaseURL) {
      try await makeClient(data: payload(.disabled), baseURL: baseURL).fetchBackupSettings()
    }
  }

  @Test
  func reportsReceiptAndTokenFailuresBeforeNetworking() async {
    let recorder = RequestRecorder()
    let transport = responseTransport(data: payload(.disabled), recorder: recorder)

    var client = BackupSettingsClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: StubOverviewFiles(values: [:], failingURL: receiptURL),
      transport: transport
    )
    await #expect(throws: BackupSettingsClientError.unreadableReceipt) {
      try await client.fetchBackupSettings()
    }

    client = configuredClient(receipt: "not-json", tokenData: Data(token.utf8), transport: transport)
    await #expect(throws: BackupSettingsClientError.unreadableReceipt) {
      try await client.fetchBackupSettings()
    }

    client = configuredClient(
      receipt: receipt(schemaVersion: 2), tokenData: Data(token.utf8), transport: transport)
    await #expect(throws: BackupSettingsClientError.incompatibleReceiptSchema(2)) {
      try await client.fetchBackupSettings()
    }

    client = configuredClient(
      receipt: receipt(), tokenData: Data(), failingURL: tokenURL, transport: transport)
    await #expect(throws: BackupSettingsClientError.unreadableToken) {
      try await client.fetchBackupSettings()
    }

    for invalidToken in [
      Data("short".utf8),
      Data(repeating: 32, count: 32),
      Data([0xFF] + Array(repeating: 65, count: 31)),
    ] {
      client = configuredClient(receipt: receipt(), tokenData: invalidToken, transport: transport)
      await #expect(throws: BackupSettingsClientError.invalidToken) {
        try await client.fetchBackupSettings()
      }
    }
    #expect(await recorder.requests.isEmpty)
  }

  @Test
  func distinguishesCancellationTransportAuthenticationAndServerFailures() async {
    let cancelled = configuredClient(
      receipt: receipt(),
      tokenData: Data(token.utf8),
      transport: StubOverviewTransport(recorder: RequestRecorder()) { _ in throw CancellationError() }
    )
    await #expect(throws: CancellationError.self) { try await cancelled.fetchBackupSettings() }

    let failed = configuredClient(
      receipt: receipt(),
      tokenData: Data(token.utf8),
      transport: StubOverviewTransport(recorder: RequestRecorder()) { _ in throw TestFailure.expected }
    )
    await #expect(throws: BackupSettingsClientError.transportFailure) {
      try await failed.fetchBackupSettings()
    }

    await #expect(throws: BackupSettingsClientError.unauthorized) {
      try await makeClient(data: Data(), status: 401).fetchBackupSettings()
    }

    await #expect(throws: BackupSettingsClientError.serverStatus(503, nil)) {
      try await makeClient(data: Data("not-json".utf8), status: 503).fetchBackupSettings()
    }

    let message = String(repeating: "x", count: 510) + "\nignored"
    let serverBody = try! JSONEncoder().encode(["error": ["message": message]])
    do {
      _ = try await makeClient(data: serverBody, status: 400).fetchBackupSettings()
      Issue.record("Expected server failure")
    } catch let error as BackupSettingsClientError {
      guard case .serverStatus(400, let sanitized) = error else {
        Issue.record("Unexpected error: \(error)")
        return
      }
      #expect(sanitized?.count == 500)
      #expect(!(sanitized?.contains("\n") ?? true))
    } catch {
      Issue.record("Unexpected error")
    }

    let emptyMessage = Data(#"{"error":{"message":"\n"}}"#.utf8)
    await #expect(throws: BackupSettingsClientError.serverStatus(409, nil)) {
      try await makeClient(data: emptyMessage, status: 409).fetchBackupSettings()
    }

    let secretMessage = try! JSONEncoder().encode([
      "error": ["message": "The token \(token) must never be shown"]
    ])
    await #expect(
      throws: BackupSettingsClientError.serverStatus(
        500, "The token [redacted] must never be shown"))
    {
      try await makeClient(data: secretMessage, status: 500).fetchBackupSettings()
    }
  }

  @Test
  func decodesEveryStateAndBothIsoDateFormats() async throws {
    for state in BackupHealthState.allCases {
      var root = rootPayload(state)
      if state == .healthy {
        var data = root["data"] as! [String: Any]
        data["lastAttemptAt"] = "2026-08-26T08:00:00Z"
        root["data"] = data
      }
      let settings = try await makeClient(data: json(root)).fetchBackupSettings()
      #expect(settings.state == state)
    }
  }

  @Test
  func rejectsNonExactMalformedAndIncompatibleEnvelopes() async {
    var payloads: [Data] = [Data("not-json".utf8), Data("[]".utf8)]

    var root = rootPayload(.disabled)
    root["extra"] = true
    payloads.append(json(root))

    root = rootPayload(.disabled)
    var meta = root["meta"] as! [String: Any]
    meta["extra"] = true
    root["meta"] = meta
    payloads.append(json(root))

    root = rootPayload(.disabled)
    var data = root["data"] as! [String: Any]
    data["extra"] = true
    root["data"] = data
    payloads.append(json(root))

    root = rootPayload(.disabled)
    data = root["data"] as! [String: Any]
    data["enabled"] = "no"
    root["data"] = data
    payloads.append(json(root))

    root = rootPayload(.healthy)
    data = root["data"] as! [String: Any]
    data["lastSuccessAt"] = "tomorrow"
    root["data"] = data
    payloads.append(json(root))

    for payload in payloads {
      await #expect(throws: BackupSettingsClientError.invalidPayload) {
        try await makeClient(data: payload).fetchBackupSettings()
      }
    }

    root = rootPayload(.disabled)
    root["meta"] = ["schemaVersion": 2]
    await #expect(throws: BackupSettingsClientError.incompatibleResponseSchema(2)) {
      try await makeClient(data: json(root)).fetchBackupSettings()
    }
  }

  @Test
  func acceptsTheUnreadableSettingsShapeAndOnlyThatOneWithoutADestination() async throws {
    // M-C6: `AutomaticBackupController` starts in `error` when its settings file is corrupt, so
    // the daemon answers `enabled: false, state: "error"` with a message and no destination.
    var root = rootPayload(.disabled)
    var data = root["data"] as! [String: Any]
    data["state"] = "error"
    data["error"] = "Backup settings file is corrupt; choose a folder to write it again."
    root["data"] = data
    let settings = try await makeClient(data: json(root)).fetchBackupSettings()
    #expect(settings.state == .error)
    #expect(!settings.enabled)
    #expect(settings.directory == nil)
    #expect(
      settings.unreadableSettingsMessage
        == "Backup settings file is corrupt; choose a folder to write it again.")
    // The other shapes keep the message out of the attention line.
    let healthy = try await makeClient(data: payload(.healthy)).fetchBackupSettings()
    #expect(healthy.unreadableSettingsMessage == nil)
    let configuredError = try await makeClient(data: payload(.error)).fetchBackupSettings()
    #expect(configuredError.unreadableSettingsMessage == nil)

    // Without a destination, only `disabled` (no error) and `error` (with one) are consistent.
    let mutations: [(inout [String: Any]) -> Void] = [
      { $0["error"] = NSNull() },
      { $0["state"] = "pending" },
      { $0["state"] = "healthy" },
      { $0["state"] = "healthy"; $0["error"] = NSNull() },
      { $0["directory"] = "/Users/example/Backup" },
      { $0["snapshotPath"] = "/Users/example/Backup/pimpampum-latest.sqlite" },
    ]
    for mutation in mutations {
      var rejectedRoot = root
      var rejected = rejectedRoot["data"] as! [String: Any]
      mutation(&rejected)
      rejectedRoot["data"] = rejected
      await #expect(throws: BackupSettingsClientError.invalidPayload) {
        try await makeClient(data: json(rejectedRoot)).fetchBackupSettings()
      }
    }
    // Enabled with a destination but `disabled` as state stays inconsistent.
    var enabledDisabled = rootPayload(.healthy)
    var enabledData = enabledDisabled["data"] as! [String: Any]
    enabledData["state"] = "disabled"
    enabledDisabled["data"] = enabledData
    await #expect(throws: BackupSettingsClientError.invalidPayload) {
      try await makeClient(data: json(enabledDisabled)).fetchBackupSettings()
    }
  }

  @Test
  func rejectsSemanticallyUnsafePayloads() async {
    let mutations: [(inout [String: Any]) -> Void] = [
      { $0["enabled"] = false },
      {
        $0["state"] = "healthy"
        $0["enabled"] = true
        $0["directory"] = NSNull()
      },
      { $0["directory"] = "relative" },
      { $0["directory"] = "/safe\0unsafe" },
      { $0["snapshotPath"] = NSNull() },
      { $0["snapshotPath"] = "relative.sqlite" },
      { $0["error"] = "" },
      { $0["error"] = String(repeating: "e", count: 501) },
      { $0["error"] = "bad\nmessage" },
    ]

    for mutation in mutations {
      var root = rootPayload(.error)
      var data = root["data"] as! [String: Any]
      mutation(&data)
      root["data"] = data
      await #expect(throws: BackupSettingsClientError.invalidPayload) {
        try await makeClient(data: json(root)).fetchBackupSettings()
      }
    }

    for key in ["directory", "snapshotPath", "error"] {
      var root = rootPayload(.disabled)
      var data = root["data"] as! [String: Any]
      data[key] = key == "error" ? "failure" : "/unexpected"
      root["data"] = data
      await #expect(throws: BackupSettingsClientError.invalidPayload) {
        try await makeClient(data: json(root)).fetchBackupSettings()
      }
    }

    var secretRoot = rootPayload(.error)
    var secretData = secretRoot["data"] as! [String: Any]
    secretData["error"] = "Unexpected secret: \(token)"
    secretRoot["data"] = secretData
    await #expect(throws: BackupSettingsClientError.invalidPayload) {
      try await makeClient(data: json(secretRoot)).fetchBackupSettings()
    }
  }

  @Test
  func exposesActionableDescriptionsForEveryFailure() {
    let errors: [BackupSettingsClientError] = [
      .unreadableReceipt,
      .incompatibleReceiptSchema(2),
      .invalidBaseURL,
      .unreadableToken,
      .invalidToken,
      .unauthorized,
      .incompatibleResponseSchema(2),
      .serverStatus(503, nil),
      .serverStatus(400, "Choose another folder."),
      .invalidPayload,
      .transportFailure,
    ]
    #expect(errors.allSatisfy { !($0.errorDescription ?? "").isEmpty })
  }

  private var token: String { String(repeating: "a", count: 40) }

  private func receipt(
    baseURL: String = "http://127.0.0.1:7337",
    schemaVersion: Int = 1
  ) -> String {
    #"{"schemaVersion":\#(schemaVersion),"baseUrl":"\#(baseURL)"}"#
  }

  private func makeClient(
    data: Data,
    recorder: RequestRecorder = RequestRecorder(),
    baseURL: String = "http://127.0.0.1:7337",
    status: Int = 200
  ) -> BackupSettingsClient {
    configuredClient(
      receipt: receipt(baseURL: baseURL),
      tokenData: Data("\(token)\n".utf8),
      transport: responseTransport(data: data, recorder: recorder, status: status)
    )
  }

  private func configuredClient(
    receipt: String,
    tokenData: Data,
    failingURL: URL? = nil,
    transport: any OverviewTransport
  ) -> BackupSettingsClient {
    BackupSettingsClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: StubOverviewFiles(
        values: [receiptURL: Data(receipt.utf8), tokenURL: tokenData],
        failingURL: failingURL
      ),
      transport: transport
    )
  }

  private func responseTransport(
    data: Data,
    recorder: RequestRecorder,
    status: Int = 200
  ) -> StubOverviewTransport {
    StubOverviewTransport(recorder: recorder) { request in
      (
        data,
        HTTPURLResponse(
          url: request.url!,
          statusCode: status,
          httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/json"]
        )!
      )
    }
  }

  private func payload(_ state: BackupHealthState) -> Data { json(rootPayload(state)) }

  private func rootPayload(_ state: BackupHealthState) -> [String: Any] {
    let enabled = state != .disabled
    return [
      "meta": ["schemaVersion": 1],
      "data": [
        "enabled": enabled,
        "directory": enabled ? "/Users/example/Backup" : NSNull(),
        "snapshotPath": enabled ? "/Users/example/Backup/pimpampum-latest.sqlite" : NSNull(),
        "state": state.rawValue,
        "lastAttemptAt": enabled ? "2026-08-26T08:00:00.000Z" : NSNull(),
        "lastSuccessAt": state == .healthy ? "2026-08-26T08:00:00.000Z" : NSNull(),
        "error": state == .error ? "The backup folder is unavailable." : NSNull(),
      ],
    ]
  }

  private func json(_ object: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }
}
