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
      error: nil
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
      error: nil
    )
  }
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
