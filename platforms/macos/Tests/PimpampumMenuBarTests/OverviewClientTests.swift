import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
struct OverviewClientTests {
  private let receiptURL = URL(fileURLWithPath: "/configuration/install-receipt.json")
  private let tokenURL = URL(fileURLWithPath: "/configuration/token")

  @Test
  func decodesTheFrozenMixedContractAndSendsOneAuthenticatedGet() async throws {
    let recorder = RequestRecorder()
    let client = makeClient(
      data: try fixtureData("mixed"),
      recorder: recorder,
      baseURL: "http://127.0.0.1:7337"
    )

    let overview = try await client.fetchOverview()

    #expect(overview.status == .active)
    #expect(
      overview.projects.map(\.status)
        == [.active, .available, .draft, .paused, .complete, .complete]
    )
    #expect(overview.projects.last?.lifecycleState == .cancelled)
    #expect(
      overview.specs.map(\.title) == [
        "Widget V1", "Cross-device synchronization", "Release integration", "Paused rollout",
        "First-run onboarding",
      ])
    #expect(overview.specs.first?.completedTaskCount == 2)
    #expect(overview.specs.first?.activeClaimCount == 2)
    #expect(overview.specs.last?.lifecycleState == .done)
    #expect(overview.activeWork.first?.title == "Current work")
    #expect(overview.activeWork.first?.id == "task:task-active:codex-task")
    #expect(overview.activeWork.first?.remainingSeconds(at: overview.generatedAt) == 1_770)
    #expect(overview.activeWork.last?.targetType == .spec)
    #expect(overview.activeWork.last?.title == "Release integration")
    #expect(overview.activeWork.last?.taskId == nil)
    #expect(overview.daemon.startedAt == isoDate("2026-08-26T20:00:00.000Z"))

    let requests = await recorder.requests
    #expect(requests.count == 1)
    #expect(requests.first?.httpMethod == "GET")
    #expect(requests.first?.url?.absoluteString == "http://127.0.0.1:7337/api/v1/overview")
    #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
    #expect(requests.first?.value(forHTTPHeaderField: "Accept") == "application/json")
  }

  @Test(arguments: [
    "http://127.0.0.1:7337",
    "http://localhost:7337/",
    "http://[::1]:7337",
  ])
  func acceptsEveryLoopbackRepresentation(baseURL: String) async throws {
    let client = makeClient(data: try fixtureData("empty"), baseURL: baseURL)
    #expect(try await client.fetchOverview().status == .empty)
  }

  @Test(arguments: [
    "https://127.0.0.1:7337",
    "http://0.0.0.0:7337",
    "http://example.com:7337",
    "http://user@localhost:7337",
    "http://localhost:7337/nested",
    "http://localhost:7337?query=yes",
    "http:",
    "not a url",
  ])
  func rejectsUnsafeBaseURLs(baseURL: String) async throws {
    let client = makeClient(data: try fixtureData("empty"), baseURL: baseURL)
    await #expect(throws: OverviewClientError.invalidBaseURL) {
      try await client.fetchOverview()
    }
  }

  @Test
  func reportsReceiptAndTokenConfigurationFailuresBeforeNetworking() async throws {
    let recorder = RequestRecorder()
    let transport = successfulTransport(data: try fixtureData("empty"), recorder: recorder)

    var client = OverviewClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: StubOverviewFiles(values: [:], failingURL: receiptURL),
      transport: transport
    )
    await #expect(throws: OverviewClientError.unreadableReceipt) {
      try await client.fetchOverview()
    }

    client = OverviewClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: StubOverviewFiles(values: [receiptURL: Data("not-json".utf8)]),
      transport: transport
    )
    await #expect(throws: OverviewClientError.unreadableReceipt) {
      try await client.fetchOverview()
    }

    client = configuredClient(
      receipt: #"{"schemaVersion":2,"baseUrl":"http://localhost:7337"}"#,
      tokenData: Data(token.utf8),
      transport: transport
    )
    await #expect(throws: OverviewClientError.incompatibleReceiptSchema(2)) {
      try await client.fetchOverview()
    }

    client = configuredClient(
      receipt: receipt(),
      tokenData: Data(),
      failingURL: tokenURL,
      transport: transport
    )
    await #expect(throws: OverviewClientError.unreadableToken) {
      try await client.fetchOverview()
    }

    for invalidToken in [
      Data("short".utf8), Data(repeating: 32, count: 32),
      Data([0xFF] + Array(repeating: 65, count: 31)),
    ] {
      client = configuredClient(
        receipt: receipt(),
        tokenData: invalidToken,
        transport: transport
      )
      await #expect(throws: OverviewClientError.invalidToken) {
        try await client.fetchOverview()
      }
    }
    #expect(await recorder.requests.isEmpty)
  }

  @Test
  func distinguishesAuthenticationServerSchemaAndPayloadFailures() async throws {
    for (status, expected) in [
      (401, OverviewClientError.unauthorized),
      (503, OverviewClientError.serverStatus(503)),
    ] {
      let client = makeClient(data: Data(), status: status)
      await #expect(throws: expected) { try await client.fetchOverview() }
    }

    let incompatible = makeClient(data: try fixtureData("invalid"))
    await #expect(throws: OverviewClientError.incompatibleOverviewSchema(1)) {
      try await incompatible.fetchOverview()
    }

    for data in [Data("not-json".utf8), Data(#"{"meta":{"schemaVersion":2}}"#.utf8)] {
      let client = makeClient(data: data)
      await #expect(throws: OverviewClientError.invalidPayload) {
        try await client.fetchOverview()
      }
    }
  }

  /// The overview poll is the one caller that must see the transport's own error: `OverviewStore`
  /// separates a cancelled refresh from a daemon that stopped answering, and a wrapped error would
  /// erase that difference. A cancellation stays a cancellation for the same reason.
  @Test
  func rethrowsTheTransportsOwnFailureInsteadOfATypedClientError() async throws {
    let failing = configuredClient(
      receipt: receipt(),
      tokenData: Data("\(token)\n".utf8),
      transport: StubOverviewTransport(recorder: RequestRecorder()) { _ in
        throw TestFailure.expected
      }
    )
    await #expect(throws: TestFailure.expected) { try await failing.fetchOverview() }

    let cancelled = configuredClient(
      receipt: receipt(),
      tokenData: Data("\(token)\n".utf8),
      transport: StubOverviewTransport(recorder: RequestRecorder()) { _ in
        throw CancellationError()
      }
    )
    await #expect(throws: CancellationError.self) { try await cancelled.fetchOverview() }
  }

  @Test
  func exposesActionableDescriptionsForEveryClientFailure() {
    let errors: [OverviewClientError] = [
      .unreadableReceipt,
      .incompatibleReceiptSchema(2),
      .invalidBaseURL,
      .unreadableToken,
      .invalidToken,
      .unauthorized,
      .incompatibleOverviewSchema(2),
      .invalidHTTPResponse,
      .serverStatus(503),
      .invalidPayload,
    ]

    #expect(errors.allSatisfy { !($0.errorDescription ?? "").isEmpty })
  }

  @Test
  func acceptsStandardIsoDatesAndRejectsMalformedDates() async throws {
    let original = try JSONSerialization.jsonObject(with: fixtureData("empty")) as! [String: Any]
    var standard = original
    var standardData = standard["data"] as! [String: Any]
    standardData["generatedAt"] = "2026-08-26T20:01:30Z"
    standard["data"] = standardData
    let standardPayload = try JSONSerialization.data(withJSONObject: standard)
    #expect(
      try await makeClient(data: standardPayload).fetchOverview().generatedAt
        == isoDate("2026-08-26T20:01:30.000Z"))

    var malformed = original
    var malformedData = malformed["data"] as! [String: Any]
    malformedData["generatedAt"] = "tomorrow"
    malformed["data"] = malformedData
    let malformedPayload = try JSONSerialization.data(withJSONObject: malformed)
    await #expect(throws: OverviewClientError.invalidPayload) {
      try await makeClient(data: malformedPayload).fetchOverview()
    }
  }

  @Test
  func acceptsSpecLevelActiveWorkWithoutTaskFields() async throws {
    let overview = try await makeClient(data: fixtureData("mixed")).fetchOverview()
    let work = try #require(overview.activeWork.last)
    #expect(work.targetType == .spec)
    #expect(work.taskId == nil)
    #expect(work.taskTitle == nil)
  }

  @Test
  func rejectsSemanticallyInvalidOrUnboundedPayloads() async throws {
    let base = try JSONSerialization.jsonObject(with: fixtureData("mixed")) as! [String: Any]
    var mutations: [(inout [String: Any]) -> Void] = []
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var daemon = data["daemon"] as! [String: Any]
      daemon["uptimeSeconds"] = -1
      data["daemon"] = daemon
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var counts = data["counts"] as! [String: Any]
      counts["projects"] = -1
      data["counts"] = counts
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      let project = (data["projects"] as! [[String: Any]])[0]
      data["projects"] = Array(repeating: project, count: 501)
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      let work = (data["activeWork"] as! [[String: Any]])[0]
      data["activeWork"] = Array(repeating: work, count: 501)
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      let spec = (data["specs"] as! [[String: Any]])[0]
      data["specs"] = Array(repeating: spec, count: 501)
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var projects = data["projects"] as! [[String: Any]]
      projects[0]["id"] = ""
      data["projects"] = projects
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var projects = data["projects"] as! [[String: Any]]
      var workspace = projects[0]["workspace"] as! [String: Any]
      workspace["id"] = ""
      projects[0]["workspace"] = workspace
      data["projects"] = projects
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var projects = data["projects"] as! [[String: Any]]
      var workspace = projects[0]["workspace"] as! [String: Any]
      workspace["rootPath"] = ""
      projects[0]["workspace"] = workspace
      data["projects"] = projects
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var projects = data["projects"] as! [[String: Any]]
      projects[1]["id"] = projects[0]["id"]
      data["projects"] = projects
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var projects = data["projects"] as! [[String: Any]]
      projects[0]["activeClaimCount"] = -1
      data["projects"] = projects
      root["data"] = data
    }
    for key in ["id", "projectId", "projectTitle", "slug", "title"] {
      mutations.append { root in
        var data = root["data"] as! [String: Any]
        var specs = data["specs"] as! [[String: Any]]
        specs[0][key] = ""
        data["specs"] = specs
        root["data"] = data
      }
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var specs = data["specs"] as! [[String: Any]]
      var workspace = specs[0]["workspace"] as! [String: Any]
      workspace["id"] = ""
      specs[0]["workspace"] = workspace
      data["specs"] = specs
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var specs = data["specs"] as! [[String: Any]]
      var workspace = specs[0]["workspace"] as! [String: Any]
      workspace["rootPath"] = ""
      specs[0]["workspace"] = workspace
      data["specs"] = specs
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var specs = data["specs"] as! [[String: Any]]
      specs[1]["id"] = specs[0]["id"]
      data["specs"] = specs
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var specs = data["specs"] as! [[String: Any]]
      specs[0]["completedTaskCount"] = -1
      data["specs"] = specs
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var work = data["activeWork"] as! [[String: Any]]
      work[0]["expiresAt"] = data["generatedAt"]
      data["activeWork"] = work
      root["data"] = data
    }
    for key in ["targetId", "projectId", "specId", "agentId"] {
      mutations.append { root in
        var data = root["data"] as! [String: Any]
        var work = data["activeWork"] as! [[String: Any]]
        work[0][key] = ""
        data["activeWork"] = work
        root["data"] = data
      }
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var work = data["activeWork"] as! [[String: Any]]
      work[0]["taskId"] = nil
      data["activeWork"] = work
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var work = data["activeWork"] as! [[String: Any]]
      work[0]["taskTitle"] = nil
      data["activeWork"] = work
      root["data"] = data
    }
    mutations.append { root in
      var data = root["data"] as! [String: Any]
      var work = data["activeWork"] as! [[String: Any]]
      // The last entry is the spec-level claim; task fields on it are a contradiction.
      work[work.count - 1]["taskId"] = "unexpected-task"
      work[work.count - 1]["taskTitle"] = "Unexpected task"
      data["activeWork"] = work
      root["data"] = data
    }
    for mutation in mutations {
      var value = base
      mutation(&value)
      let client = makeClient(data: try JSONSerialization.data(withJSONObject: value))
      await #expect(throws: OverviewClientError.invalidPayload) {
        try await client.fetchOverview()
      }
    }
  }

  @Test
  func productionTransportRejectsANonHTTPResponse() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NonHTTPURLProtocol.self]
    let transport = URLSessionOverviewTransport(session: URLSession(configuration: configuration))
    await #expect(throws: OverviewClientError.invalidHTTPResponse) {
      _ = try await transport.data(for: URLRequest(url: URL(string: "http://localhost")!))
    }
  }

  private var token: String { String(repeating: "a", count: 40) }

  private func receipt(baseURL: String = "http://127.0.0.1:7337") -> String {
    #"{"schemaVersion":1,"baseUrl":"\#(baseURL)"}"#
  }

  private func configuredClient(
    receipt: String,
    tokenData: Data,
    failingURL: URL? = nil,
    transport: any OverviewTransport
  ) -> OverviewClient {
    OverviewClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: StubOverviewFiles(
        values: [receiptURL: Data(receipt.utf8), tokenURL: tokenData],
        failingURL: failingURL
      ),
      transport: transport
    )
  }

  private func makeClient(
    data: Data,
    recorder: RequestRecorder = RequestRecorder(),
    baseURL: String = "http://127.0.0.1:7337",
    status: Int = 200
  ) -> OverviewClient {
    configuredClient(
      receipt: receipt(baseURL: baseURL),
      tokenData: Data("\(token)\n".utf8),
      transport: successfulTransport(data: data, recorder: recorder, status: status)
    )
  }

  private func successfulTransport(
    data: Data,
    recorder: RequestRecorder,
    status: Int = 200
  ) -> StubOverviewTransport {
    StubOverviewTransport(recorder: recorder) { request in
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
      )!
      return (data, response)
    }
  }
}

private final class NonHTTPURLProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with _: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    client?.urlProtocol(
      self,
      didReceive: URLResponse(
        url: request.url!, mimeType: nil, expectedContentLength: 0, textEncodingName: nil),
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
