import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
struct SyncSettingsClientTests {
  private let receiptURL = URL(fileURLWithPath: "/configuration/install-receipt.json")
  private let tokenURL = URL(fileURLWithPath: "/configuration/token")
  private let token = String(repeating: "s", count: 40)

  @Test
  func sendsEveryAuthenticatedOperationAndDecodesTheStrictEnvelope() async throws {
    let recorder = RequestRecorder()
    let client = makeClient(data: payload(), recorder: recorder)

    _ = try await client.fetch()
    _ = try await client.configure(directory: "/Users/example/Shared", deviceId: "macbook-pro")
    _ = try await client.reconcile()
    _ = try await client.pause()
    _ = try await client.resume()
    _ = try await client.forget()

    let requests = await recorder.requests
    #expect(requests.map(\.httpMethod) == ["GET", "PUT", "POST", "POST", "POST", "DELETE"])
    #expect(
      requests.map { $0.url?.path } == [
        "/api/v1/settings/sync",
        "/api/v1/settings/sync",
        "/api/v1/settings/sync/reconcile",
        "/api/v1/settings/sync/pause",
        "/api/v1/settings/sync/resume",
        "/api/v1/settings/sync",
      ])
    #expect(
      requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)" })
    let body = try JSONDecoder().decode([String: String].self, from: requests[1].httpBody!)
    #expect(body == ["directory": "/Users/example/Shared", "deviceId": "macbook-pro"])
  }

  @Test
  func preservesActionableFailuresAndRedactsTheToken() async {
    await #expect(throws: SyncSettingsClientError.unauthorized) {
      try await makeClient(data: Data(), status: 401).fetch()
    }
    let serverBody = try! JSONEncoder().encode([
      "error": ["message": "The token \(token) must never be shown"]
    ])
    await #expect(
      throws: SyncSettingsClientError.serverStatus(
        409, "The token [redacted] must never be shown")
    ) {
      try await makeClient(data: serverBody, status: 409).fetch()
    }
    let transportFailure = configuredClient(
      transport: StubOverviewTransport(recorder: RequestRecorder()) { _ in
        throw TestFailure.expected
      }
    )
    await #expect(throws: SyncSettingsClientError.transportFailure) {
      try await transportFailure.fetch()
    }
    let cancellation = configuredClient(
      transport: StubOverviewTransport(recorder: RequestRecorder()) { _ in throw CancellationError()
      }
    )
    await #expect(throws: CancellationError.self) { try await cancellation.fetch() }
  }

  @Test
  func rejectsIncompatibleMalformedAndSemanticallyUnsafePayloads() async {
    var incompatible = rootPayload()
    incompatible["meta"] = ["schemaVersion": 2]
    await #expect(throws: SyncSettingsClientError.incompatibleResponseSchema(2)) {
      try await makeClient(data: json(incompatible)).fetch()
    }

    for mutation in [
      { (data: inout [String: Any]) in data["directory"] = "relative" },
      { (data: inout [String: Any]) in data["deviceId"] = "trailing-" },
      { (data: inout [String: Any]) in data["pendingSnapshotCount"] = -1 },
      { (data: inout [String: Any]) in data["error"] = "bad\nmessage" },
      { (data: inout [String: Any]) in data["extra"] = true },
      { (data: inout [String: Any]) in data["error"] = "leaked \(token)" },
      { (data: inout [String: Any]) in data.removeValue(forKey: "blockedSnapshot") },
      { (data: inout [String: Any]) in data["blockedSnapshot"] = "text" },
      { (data: inout [String: Any]) in data["blockedSnapshot"] = ["path": "a"] },
      { (data: inout [String: Any]) in
        data["blockedSnapshot"] = ["path": "a", "reason": "r", "extra": true]
      },
      { (data: inout [String: Any]) in data["blockedSnapshot"] = ["path": "", "reason": "r"] },
      { (data: inout [String: Any]) in
        data["blockedSnapshot"] = ["path": "a", "reason": "bad\ncontrol"]
      },
      { (data: inout [String: Any]) in
        data["blockedSnapshot"] = ["path": "a", "reason": "leaked \(token)"]
      },
      { (data: inout [String: Any]) in
        data["blockedSnapshot"] = ["path": "\(token).json", "reason": "r"]
      },
    ] {
      var root = rootPayload()
      var data = root["data"] as! [String: Any]
      mutation(&data)
      root["data"] = data
      await #expect(throws: SyncSettingsClientError.invalidPayload) {
        try await makeClient(data: json(root)).fetch()
      }
    }
  }

  // Every configuration failure keeps its own cause. Collapsing them would tell a user with a
  // damaged token to check that the daemon is running.
  @Test
  func mapsEveryConfigurationFailureToItsOwnCause() async {
    let receipt = Data(#"{"schemaVersion":1,"baseUrl":"http://127.0.0.1:7337"}"#.utf8)
    let expectations: [(Data?, Data?, SyncSettingsClientError)] = [
      (nil, Data("\(token)\n".utf8), .unreadableReceipt),
      (Data("not json".utf8), Data("\(token)\n".utf8), .unreadableReceipt),
      (
        Data(#"{"schemaVersion":2,"baseUrl":"http://127.0.0.1:7337"}"#.utf8),
        Data("\(token)\n".utf8), .incompatibleReceiptSchema(2)
      ),
      (
        Data(#"{"schemaVersion":1,"baseUrl":"http://example.com"}"#.utf8),
        Data("\(token)\n".utf8), .invalidBaseURL
      ),
      (receipt, nil, .unreadableToken),
      (receipt, Data("short\n".utf8), .invalidToken),
    ]

    for (receiptData, tokenData, expected) in expectations {
      await #expect(throws: expected) {
        try await unreachableClient(receipt: receiptData, token: tokenData).fetch()
      }
    }
  }

  @Test
  func defaultsToTheLocalFileReaderAndTransport() {
    let client = SyncSettingsClient(receiptURL: receiptURL, tokenURL: tokenURL)

    #expect(client.receiptURL == receiptURL)
    #expect(client.tokenURL == tokenURL)
  }

  // The daemon writes ISO 8601. Anything else is a payload this client refuses rather than
  // silently reads as a missing timestamp.
  @Test
  func rejectsATimestampThatIsNotISO8601() async {
    var root = rootPayload()
    var data = root["data"] as! [String: Any]
    data["lastAttemptAt"] = "27 August 2026"
    root["data"] = data

    await #expect(throws: SyncSettingsClientError.invalidPayload) {
      try await makeClient(data: json(root)).fetch()
    }
  }

  // A disabled instance is a complete, valid state: no directory, no device, and nothing paused.
  // Every other combination of those three is a payload the daemon cannot legitimately produce.
  @Test
  func acceptsADisabledPayloadAndRejectsAnInconsistentOne() async throws {
    var root = rootPayload()
    var disabledData = root["data"] as! [String: Any]
    disabledData["enabled"] = false
    disabledData["state"] = "disabled"
    disabledData["directory"] = NSNull()
    disabledData["deviceId"] = NSNull()
    root["data"] = disabledData

    let disabled = try await makeClient(data: json(root)).fetch()
    #expect(disabled.state == .disabled)
    #expect(!disabled.enabled)

    for mutation in [
      { (data: inout [String: Any]) in data["directory"] = NSNull() },
      { (data: inout [String: Any]) in
        data["enabled"] = false
        data["directory"] = NSNull()
        data["deviceId"] = NSNull()
      },
      { (data: inout [String: Any]) in
        data["enabled"] = false
        data["state"] = "disabled"
        data["paused"] = true
        data["directory"] = NSNull()
        data["deviceId"] = NSNull()
      },
    ] {
      var inconsistent = rootPayload()
      var data = inconsistent["data"] as! [String: Any]
      mutation(&data)
      inconsistent["data"] = data
      await #expect(throws: SyncSettingsClientError.invalidPayload) {
        try await makeClient(data: json(inconsistent)).fetch()
      }
    }
  }

  // A paused instance keeps its directory and device, so it is valid only while it reports the
  // paused state. Every other pairing of the pause flag and the health state is a payload the
  // daemon cannot produce.
  @Test
  func decodesABlockedSnapshotAndItsAbsence() async throws {
    // The daemon skips a shared snapshot that fails validation and names it in its status. The
    // panel shows it on one line; a null means every snapshot was accepted.
    var root = rootPayload()
    var data = root["data"] as! [String: Any]
    data["state"] = "error"
    data["error"] = "One snapshot was skipped."
    data["blockedSnapshot"] = ["path": "devices/laptop/snapshot-7.json", "reason": "checksum mismatch"]
    root["data"] = data
    let blocked = try await makeClient(data: json(root)).fetch()
    #expect(
      blocked.blockedSnapshot
        == SyncBlockedSnapshot(path: "devices/laptop/snapshot-7.json", reason: "checksum mismatch"))
    #expect(
      SyncSettingsPresentation.blockedSnapshotLine(blocked)
        == "Blocked snapshot devices/laptop/snapshot-7.json: checksum mismatch")

    let clean = try await makeClient(data: payload()).fetch()
    #expect(clean.blockedSnapshot == nil)
    #expect(SyncSettingsPresentation.blockedSnapshotLine(clean) == nil)

    // Disabled synchronization has no shared folder, so it cannot have refused a file.
    var disabled = rootPayload()
    var disabledData = disabled["data"] as! [String: Any]
    disabledData["enabled"] = false
    disabledData["state"] = "disabled"
    disabledData["directory"] = NSNull()
    disabledData["deviceId"] = NSNull()
    disabledData["blockedSnapshot"] = ["path": "a", "reason": "r"]
    disabled["data"] = disabledData
    await #expect(throws: SyncSettingsClientError.invalidPayload) {
      try await makeClient(data: json(disabled)).fetch()
    }
  }

  @Test
  func tiesThePauseFlagToThePausedState() async throws {
    var root = rootPayload()
    var pausedData = root["data"] as! [String: Any]
    pausedData["paused"] = true
    pausedData["state"] = "paused"
    root["data"] = pausedData

    let paused = try await makeClient(data: json(root)).fetch()
    #expect(paused.paused)
    #expect(paused.state == .paused)

    for mutation in [
      { (data: inout [String: Any]) in
        data["paused"] = true
        data["state"] = "healthy"
      },
      { (data: inout [String: Any]) in data["state"] = "disabled" },
      { (data: inout [String: Any]) in data["state"] = "paused" },
    ] {
      var inconsistent = rootPayload()
      var data = inconsistent["data"] as! [String: Any]
      mutation(&data)
      inconsistent["data"] = data
      await #expect(throws: SyncSettingsClientError.invalidPayload) {
        try await makeClient(data: json(inconsistent)).fetch()
      }
    }
  }

  // A failing status with nothing quotable falls back to the status code. An unreadable body and
  // a body whose message is only whitespace must not reach the panel as an empty notice.
  @Test
  func fallsBackToTheStatusCodeWhenTheBodyCarriesNoUsableMessage() async {
    for body in [
      Data("not json".utf8),
      try! JSONSerialization.data(withJSONObject: ["error": [:]]),
      try! JSONSerialization.data(withJSONObject: ["error": ["message": "   \n  "]]),
    ] {
      await #expect(throws: SyncSettingsClientError.serverStatus(500, nil)) {
        try await makeClient(data: body, status: 500).fetch()
      }
    }
  }

  private func unreachableClient(receipt: Data?, token tokenData: Data?) -> SyncSettingsClient {
    var values: [URL: Data] = [:]
    if let receipt { values[receiptURL] = receipt }
    if let tokenData { values[tokenURL] = tokenData }
    return SyncSettingsClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: StubOverviewFiles(values: values),
      transport: StubOverviewTransport(recorder: RequestRecorder()) { _ in
        Issue.record("A client without a configuration must never reach the transport")
        throw TestFailure.expected
      }
    )
  }

  private func makeClient(
    data: Data,
    recorder: RequestRecorder = RequestRecorder(),
    status: Int = 200
  ) -> SyncSettingsClient {
    configuredClient(
      transport: StubOverviewTransport(recorder: recorder) { request in
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
    )
  }

  private func configuredClient(transport: any OverviewTransport) -> SyncSettingsClient {
    SyncSettingsClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: StubOverviewFiles(values: [
        receiptURL: Data(#"{"schemaVersion":1,"baseUrl":"http://127.0.0.1:7337"}"#.utf8),
        tokenURL: Data("\(token)\n".utf8),
      ]),
      transport: transport
    )
  }

  private func payload() -> Data { json(rootPayload()) }

  private func rootPayload() -> [String: Any] {
    [
      "meta": ["schemaVersion": 1],
      "data": [
        "enabled": true,
        "paused": false,
        "state": "healthy",
        "directory": "/Users/example/Shared/Pimpampum",
        "deviceId": "macbook-pro",
        "lastAttemptAt": "2026-08-27T08:00:00.000Z",
        "lastImportAt": NSNull(),
        "lastExportAt": "2026-08-27T08:00:01Z",
        "pendingSnapshotCount": 0,
        "conflictCount": 0,
        "error": NSNull(),
        "blockedSnapshot": NSNull(),
      ],
    ]
  }

  private func json(_ value: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  }
}

@Suite(.serialized)
@MainActor
struct SyncSettingsStoreTests {
  @Test
  func keepsLastGoodSettingsAndSurfacesTypedErrors() async {
    let current = settings()
    let client = SequenceSyncSettingsReader([
      .success(current),
      .failure(.serverStatus(400, "Choose another shared folder.")),
    ])
    let store = SyncSettingsStore(client: client)

    await store.load()
    await store.syncNow()

    #expect(store.settings == current)
    #expect(store.errorMessage == "Choose another shared folder.")
    #expect(!store.busy)
  }

  // Configure, resume, pause, and forget all run through the same guarded path, so the busy flag
  // and the cleared error apply to every administrative change, not only to a refresh.
  @Test
  func runsEveryAdministrativeOperationThroughTheGuardedPath() async {
    let current = settings()
    let client = SequenceSyncSettingsReader([
      .success(current), .success(current), .success(current), .success(current), .success(current),
    ])
    let store = SyncSettingsStore(client: client)

    await store.configure(directory: "/tmp/Shared/Pimpampum", deviceId: "macbook")
    await store.syncNow()
    await store.setEnabled(true)
    await store.setEnabled(false)
    await store.forget()

    #expect(store.settings == current)
    #expect(store.errorMessage == nil)
    #expect(!store.busy)
  }

  // An untyped failure still has to promise that nothing local was lost. Falling through to a raw
  // error description would put an unreadable cause in front of the user instead.
  @Test
  func reportsAnUntypedFailureWithoutThreateningLocalWork() async {
    let store = SyncSettingsStore(client: UntypedFailureSyncSettingsReader())

    await store.load()

    #expect(
      store.errorMessage
        == "\(PimpampumBrand.displayName) could not update synchronization. Your local changes are safe."
    )
    #expect(store.settings == nil)
  }

  // One operation at a time. A second administrative change while the first is in flight would
  // race the daemon and publish whichever reply landed last.
  @Test
  func refusesASecondOperationWhileOneIsStillRunning() async {
    let gate = SyncGate()
    let store = SyncSettingsStore(
      client: GatedSyncSettingsReader(gate: gate, settings: settings())
    )

    let first = Task { await store.load() }
    var attempts = 0
    while !store.busy, attempts < 10_000 {
      await Task.yield()
      attempts += 1
    }
    await store.syncNow()

    #expect(store.settings == nil)
    await gate.open()
    await first.value
    #expect(store.settings == settings())
  }

  // A cancelled operation is not a failure. Reporting one would put a notice in the panel every
  // time the settings window closed mid-request.
  @Test
  func ignoresACancelledOperationInsteadOfReportingAFailure() async {
    let store = SyncSettingsStore(client: CancellingSyncSettingsReader())

    await store.load()

    #expect(store.errorMessage == nil)
    #expect(store.settings == nil)
    #expect(!store.busy)
  }

  private func settings() -> SyncSettings {
    SyncSettings(
      enabled: true,
      paused: false,
      state: .healthy,
      directory: "/tmp/Shared/Pimpampum",
      deviceId: "macbook",
      lastAttemptAt: nil,
      lastImportAt: nil,
      lastExportAt: nil,
      pendingSnapshotCount: 0,
      conflictCount: 0,
      error: nil,
      blockedSnapshot: nil
    )
  }
}

@Suite(.serialized)
@MainActor
struct SyncSettingsPresentationTests {
  @Test
  func givesActionableRecoveryGuidanceWithoutThreateningLocalWork() {
    let conflict = settings(state: .conflict, conflicts: 2)
    let unavailable = settings(state: .unavailable)
    let error = settings(state: .error)

    #expect(
      SyncSettingsView.recoveryGuidance(for: conflict)?.contains("pimpampum sync conflicts") == true
    )
    #expect(
      SyncSettingsView.recoveryGuidance(for: conflict)?.contains("local projects stay available")
        == true)
    #expect(
      SyncSettingsView.recoveryGuidance(for: unavailable)?.contains("local projects are safe")
        == true)
    #expect(
      SyncSettingsView.recoveryGuidance(for: error)?.contains("local projects are safe") == true)
    #expect(SyncSettingsView.recoveryGuidance(for: settings(state: .healthy)) == nil)
  }

  private func settings(state: SyncHealthState, conflicts: Int = 0) -> SyncSettings {
    SyncSettings(
      enabled: true,
      paused: false,
      state: state,
      directory: "/tmp/Shared/Pimpampum",
      deviceId: "macbook",
      lastAttemptAt: nil,
      lastImportAt: nil,
      lastExportAt: nil,
      pendingSnapshotCount: 0,
      conflictCount: conflicts,
      error: nil,
      blockedSnapshot: nil
    )
  }

  @Test
  func namesTheBlockedSnapshotOnOneLineOrStaysSilent() {
    let clean = settings(state: .healthy)
    #expect(SyncSettingsPresentation.blockedSnapshotLine(clean) == nil)
    let blocked = SyncSettings(
      enabled: true,
      paused: false,
      state: .error,
      directory: "/tmp/Shared/Pimpampum",
      deviceId: "macbook",
      lastAttemptAt: nil,
      lastImportAt: nil,
      lastExportAt: nil,
      pendingSnapshotCount: 1,
      conflictCount: 0,
      error: "One snapshot was skipped.",
      blockedSnapshot: SyncBlockedSnapshot(
        path: "devices/laptop/snapshot-7.json", reason: "checksum mismatch")
    )
    #expect(
      SyncSettingsPresentation.blockedSnapshotLine(blocked)
        == "Blocked snapshot devices/laptop/snapshot-7.json: checksum mismatch")
  }
}

@Suite
struct SyncSettingsModelsTests {
  // The popout and the panel render these strings directly. They are frozen copy, so a rename
  // has to be a deliberate edit here rather than a silent change of what the bar says.
  @Test
  func everyHealthStateNamesItselfInPlainLanguage() {
    #expect(SyncHealthState.disabled.label == "Not configured")
    #expect(SyncHealthState.paused.label == "Synchronization paused")
    #expect(SyncHealthState.pending.label == "Changes pending")
    #expect(SyncHealthState.importing.label == "Importing changes…")
    #expect(SyncHealthState.exporting.label == "Exporting changes…")
    #expect(SyncHealthState.healthy.label == "Up to date")
    #expect(SyncHealthState.unavailable.label == "Shared folder unavailable")
    #expect(SyncHealthState.error.label == "Synchronization needs attention")
    #expect(SyncHealthState.conflict.label == "Conflict requires attention")
  }

  @Test
  func everyFailureExplainsItselfAndNamesItsRepair() {
    let brand = PimpampumBrand.displayName

    #expect(
      SyncSettingsClientError.unreadableReceipt.errorDescription
        == "\(brand)'s installation receipt could not be read. Run pimpampum install."
    )
    #expect(
      SyncSettingsClientError.incompatibleReceiptSchema(2).errorDescription
        == "The installed \(brand) receipt uses unsupported schema version 2."
    )
    #expect(
      SyncSettingsClientError.invalidBaseURL.errorDescription
        == "\(brand)'s configured URL must be an authenticated loopback HTTP endpoint."
    )
    #expect(
      SyncSettingsClientError.unreadableToken.errorDescription
        == "\(brand)'s local token file could not be read. Run pimpampum install."
    )
    #expect(
      SyncSettingsClientError.invalidToken.errorDescription
        == "\(brand)'s local token is invalid. Run pimpampum install to repair it."
    )
    #expect(
      SyncSettingsClientError.unauthorized.errorDescription
        == "\(brand) rejected the local token. Run pimpampum install to reconcile it."
    )
    #expect(
      SyncSettingsClientError.incompatibleResponseSchema(3).errorDescription
        == "\(brand) returned unsupported synchronization schema version 3."
    )
    // The daemon's own message wins when it sent one; the status code is the fallback.
    #expect(
      SyncSettingsClientError.serverStatus(409, "Choose another shared folder.").errorDescription
        == "Choose another shared folder."
    )
    #expect(
      SyncSettingsClientError.serverStatus(503, nil).errorDescription
        == "\(brand) returned HTTP status 503."
    )
    #expect(
      SyncSettingsClientError.invalidPayload.errorDescription
        == "\(brand) returned an invalid synchronization response."
    )
    #expect(
      SyncSettingsClientError.transportFailure.errorDescription
        == "\(brand) could not be reached. Check that the daemon is running."
    )
  }
}

private actor SyncGate {
  private var continuation: CheckedContinuation<Void, Never>?
  private var opened = false

  func wait() async {
    if opened { return }
    await withCheckedContinuation { self.continuation = $0 }
  }

  func open() {
    opened = true
    continuation?.resume()
    continuation = nil
  }
}

private struct GatedSyncSettingsReader: SyncSettingsReading {
  let gate: SyncGate
  let settings: SyncSettings

  func fetch() async throws -> SyncSettings {
    await gate.wait()
    return settings
  }
  func configure(directory: String, deviceId: String) async throws -> SyncSettings {
    try await fetch()
  }
  func reconcile() async throws -> SyncSettings { try await fetch() }
  func pause() async throws -> SyncSettings { try await fetch() }
  func resume() async throws -> SyncSettings { try await fetch() }
  func forget() async throws -> SyncSettings { try await fetch() }
}

private struct CancellingSyncSettingsReader: SyncSettingsReading {
  func fetch() async throws -> SyncSettings { throw CancellationError() }
  func configure(directory: String, deviceId: String) async throws -> SyncSettings {
    throw CancellationError()
  }
  func reconcile() async throws -> SyncSettings { throw CancellationError() }
  func pause() async throws -> SyncSettings { throw CancellationError() }
  func resume() async throws -> SyncSettings { throw CancellationError() }
  func forget() async throws -> SyncSettings { throw CancellationError() }
}

private struct UntypedFailureSyncSettingsReader: SyncSettingsReading {
  func fetch() async throws -> SyncSettings { throw TestFailure.expected }
  func configure(directory: String, deviceId: String) async throws -> SyncSettings {
    throw TestFailure.expected
  }
  func reconcile() async throws -> SyncSettings { throw TestFailure.expected }
  func pause() async throws -> SyncSettings { throw TestFailure.expected }
  func resume() async throws -> SyncSettings { throw TestFailure.expected }
  func forget() async throws -> SyncSettings { throw TestFailure.expected }
}

private actor SequenceSyncSettingsReader: SyncSettingsReading {
  enum Outcome: Sendable {
    case success(SyncSettings)
    case failure(SyncSettingsClientError)
  }

  private var outcomes: [Outcome]

  init(_ outcomes: [Outcome]) { self.outcomes = outcomes }

  func fetch() async throws -> SyncSettings { try next() }
  func configure(directory: String, deviceId: String) async throws -> SyncSettings { try next() }
  func reconcile() async throws -> SyncSettings { try next() }
  func pause() async throws -> SyncSettings { try next() }
  func resume() async throws -> SyncSettings { try next() }
  func forget() async throws -> SyncSettings { try next() }

  private func next() throws -> SyncSettings {
    switch outcomes.removeFirst() {
    case .success(let settings): settings
    case .failure(let error): throw error
    }
  }
}
