import Foundation
import Testing

@testable import PimpampumMenuBar

private struct FixtureDetector: SetupAgentDetecting {
  let detected: Set<SetupAgentID>
  func detect() async -> Set<SetupAgentID> { detected }
}

private actor FixtureSetupRunner: SetupCommandRunning {
  var relaunchCalls = 0
  var plannedSelections: [[SetupAgentID]] = []
  var applyCalls = 0
  var resumeCalls = 0
  var retryCalls: [SetupAgentID] = []
  var journal: SetupJournal?
  var failure: Error?
  var applyResponse = success
  var retryResponse = success
  var plannedConflicts: [SetupConflict] = []
  var lastReplacing: [SetupAgentID] = []
  var lastKeeping: [SetupAgentID] = []

  @MainActor
  func relaunchInstalledApplicationIfNeeded() async throws -> Bool {
    await recordRelaunch()
    return true
  }

  private func recordRelaunch() { relaunchCalls += 1 }

  func plan(selectedConnectors: [SetupAgentID]) async throws -> SetupPlan {
    if let failure { throw failure }
    plannedSelections.append(selectedConnectors)
    return SetupPlan(
      operationId: "operation-1",
      revision: "revision-1",
      selectedConnectors: selectedConnectors,
      changes: [SetupChange(kind: "service", summary: "Install private service", path: nil)],
      conflicts: plannedConflicts,
      requiresConfirmation: true
    )
  }

  func apply(
    operationID _: String,
    revision _: String,
    replacing: [SetupAgentID],
    keeping: [SetupAgentID],
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    applyCalls += 1
    lastReplacing = replacing
    lastKeeping = keeping
    await onProgress(
      SetupProgressEvent(
        schemaVersion: 1,
        operationId: "operation-1",
        phase: "connector:codex.verify",
        status: .completed,
        occurredAt: "2026-08-31T10:00:00.000Z",
        connectorId: .codex,
        diagnostic: nil
      ))
    return applyResponse
  }

  func status() async throws -> SetupJournal? { journal }

  func resume(
    onProgress _: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    resumeCalls += 1
    return Self.success
  }

  func retry(
    _ id: SetupAgentID,
    onProgress _: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    retryCalls.append(id)
    return retryResponse
  }

  static let success = SetupResult(
    status: .complete,
    service: SetupServiceResult(installed: true, running: true, verified: true),
    connectors: [
      SetupConnectorResult(
        id: .codex,
        configured: true,
        available: true,
        newSessionRequired: true,
        state: "connected",
        error: nil
      )
    ],
    nextAction: .newSession
  )
}

private actor RecordingProcessRunner: SetupProcessRunning {
  var executable: URL?
  var arguments: [String] = []

  func run(
    executable: URL,
    arguments: [String],
    cancellationAllowed _: Bool
  ) async throws -> SetupCommandOutput {
    self.executable = executable
    self.arguments = arguments
    let output = Data(
      #"{"data":{"operationId":"operation","revision":"revision","selectedConnectors":["codex"],"changes":[],"conflicts":[],"requiresConfirmation":true}}"#
        .utf8
    )
    return SetupCommandOutput(
      exitCode: 0,
      standardOutput: output,
      standardError: Data(),
      exceededLimit: false,
      cancelled: false
    )
  }
}

private actor StreamingProcessRunner: SetupStreamingProcessRunning {
  var arguments: [String] = []

  func run(
    executable: URL,
    arguments: [String],
    cancellationAllowed: Bool
  ) async throws -> SetupCommandOutput {
    try await run(
      executable: executable,
      arguments: arguments,
      cancellationAllowed: cancellationAllowed,
      onStandardOutputLine: { _ in }
    )
  }

  func run(
    executable _: URL,
    arguments: [String],
    cancellationAllowed _: Bool,
    onStandardOutputLine: @escaping @Sendable (Data) -> Void
  ) async throws -> SetupCommandOutput {
    self.arguments = arguments
    let progress = Data(
      #"{"schemaVersion":1,"event":"progress","data":{"schemaVersion":1,"operationId":"operation","phase":"connector:codex.verify","status":"completed","occurredAt":"2026-08-31T10:00:00.000Z","connectorId":"codex"}}"#
        .utf8
    )
    let result = Data(
      #"{"schemaVersion":1,"event":"result","data":{"status":"complete","service":{"installed":true,"running":true,"verified":true},"connectors":[{"id":"codex","configured":true,"available":true,"newSessionRequired":false,"state":"connected"}],"nextAction":"done"}}"#
        .utf8
    )
    onStandardOutputLine(progress)
    return SetupCommandOutput(
      exitCode: 0,
      standardOutput: progress + Data([0x0A]) + result,
      standardError: Data(),
      exceededLimit: false,
      cancelled: false
    )
  }
}

private final class ActivityProbeRunner: SetupCommandRunning, @unchecked Sendable {
  weak var store: SetupStore?
  var activityDuringStatus: SetupActivity = .idle
  var resumeCalls = 0

  func plan(selectedConnectors _: [SetupAgentID]) async throws -> SetupPlan {
    throw SetupClientError.unavailable
  }

  func apply(
    operationID _: String,
    revision _: String,
    replacing _: [SetupAgentID],
    keeping _: [SetupAgentID],
    onProgress _: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    throw SetupClientError.unavailable
  }

  func status() async throws -> SetupJournal? {
    activityDuringStatus = await MainActor.run { self.store?.activity ?? .idle }
    return nil
  }

  func resume(
    onProgress _: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    resumeCalls += 1
    throw SetupClientError.unavailable
  }

  func retry(
    _: SetupAgentID,
    onProgress _: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    throw SetupClientError.unavailable
  }
}

private actor ProgressRecorder {
  var events: [SetupProgressEvent] = []
  func append(_ event: SetupProgressEvent) { events.append(event) }
}

@Suite("Strict setup client and durable store")
struct SetupClientStoreTests {
  @Test("decodes bounded versioned NDJSON progress and result events")
  func decodesEvents() throws {
    let source = """
      {"schemaVersion":1,"event":"progress","data":{"schemaVersion":1,"operationId":"operation","phase":"service.verify","status":"completed","occurredAt":"2026-08-31T10:00:00.000Z"}}
      {"data":{"status":"complete","service":{"installed":true,"running":true,"verified":true},"connectors":[],"nextAction":"done"}}
      """
    let events = try SetupNDJSONDecoder.decode(Data(source.utf8))
    #expect(events.count == 2)
    guard case .progress(let progress) = events[0], case .result(let result) = events[1] else {
      Issue.record("Expected progress followed by result")
      return
    }
    #expect(progress.phase == "service.verify")
    #expect(result.service.verified)
  }

  @Test("rejects unknown schemas and oversized individual events")
  func rejectsUnsafeEvents() {
    let incompatible = Data(
      #"{"schemaVersion":2,"event":"progress","data":{"schemaVersion":2}}"#.utf8)
    #expect(throws: SetupClientError.incompatibleSchema) {
      try SetupNDJSONDecoder.decode(incompatible)
    }
    let mismatched = Data(
      #"{"schemaVersion":1,"event":"plan","data":{"schemaVersion":1,"operationId":"operation","phase":"service.verify","status":"completed","occurredAt":"2026-08-31T10:00:00.000Z"}}"#
        .utf8
    )
    #expect(throws: SetupClientError.invalidResponse) {
      try SetupNDJSONDecoder.decode(mismatched)
    }
    let oversized = Data(repeating: 0x61, count: SetupNDJSONDecoder.maximumEventBytes + 1)
    #expect(throws: SetupClientError.responseTooLarge) {
      try SetupNDJSONDecoder.decode(oversized)
    }
    let optionSmuggling = Data(
      #"{"data":{"operationId":"--help","revision":"revision","selectedConnectors":[],"changes":[],"conflicts":[],"requiresConfirmation":true}}"#
        .utf8
    )
    #expect(throws: SetupClientError.invalidResponse) {
      try SetupNDJSONDecoder.decode(optionSmuggling)
    }
    let duplicateJournal = Data(
      #"{"data":{"schemaVersion":1,"operationId":"operation","revision":"revision","phase":"complete","selectedConnectors":["codex","codex"],"completedPhases":[],"diagnostics":[],"service":{"installed":true,"running":true,"verified":true},"connectors":[],"loginItem":"enabled","status":"complete","updatedAt":"2026-08-31T10:00:00.000Z"}}"#
        .utf8
    )
    #expect(throws: SetupClientError.invalidResponse) {
      try SetupNDJSONDecoder.decode(duplicateJournal)
    }
  }

  @Test("always launches the embedded executable with an argument array")
  func usesEmbeddedRuntime() async throws {
    let process = RecordingProcessRunner()
    let runtime = EmbeddedControlRuntime(
      rootURL: URL(
        fileURLWithPath: "/Applications/Pimpampum.app/Contents/Resources/PimpampumRuntime"),
      executableURL: URL(fileURLWithPath: "/private/runtime/bin/node"),
      cliURL: URL(fileURLWithPath: "/private/runtime/dist/cli.js")
    )
    let bootstrap = EmbeddedSetupBootstrap(
      runtime: runtime,
      sourceApplicationURL: URL(fileURLWithPath: "/Downloads/Pimpampum.app"),
      homeDirectory: URL(fileURLWithPath: "/Users/example")
    )
    let plan = try await SetupCommandRunner(
      bootstrap: bootstrap,
      processRunner: process
    ).plan(selectedConnectors: [.codex])
    #expect(plan.operationId == "operation")
    #expect(await process.executable == runtime.executableURL)
    #expect(
      await process.arguments == [runtime.cliURL.path, "setup", "plan", "--connector", "codex"])
  }

  @Test("cancels a read-only child and waits for it to exit")
  func cancelsBeforeMutation() async throws {
    let task = Task {
      try await LocalSetupProcessRunner().run(
        executable: URL(fileURLWithPath: "/bin/sleep"),
        arguments: ["30"],
        cancellationAllowed: true
      )
    }
    try await Task.sleep(for: .milliseconds(100))
    task.cancel()
    let output = try await task.value
    #expect(output.cancelled)
    #expect(output.exitCode != 0)
  }

  @Test("delivers native progress before returning the final result")
  func streamsProgress() async throws {
    let process = StreamingProcessRunner()
    let recorder = ProgressRecorder()
    let runtime = EmbeddedControlRuntime(
      rootURL: URL(fileURLWithPath: "/private/runtime"),
      executableURL: URL(fileURLWithPath: "/private/runtime/bin/node"),
      cliURL: URL(fileURLWithPath: "/private/runtime/dist/cli.js")
    )
    let runner = SetupCommandRunner(
      bootstrap: EmbeddedSetupBootstrap(
        runtime: runtime,
        sourceApplicationURL: URL(fileURLWithPath: "/Downloads/Pimpampum.app"),
        homeDirectory: URL(fileURLWithPath: "/Users/example")
      ),
      processRunner: process
    )
    let result = try await runner.apply(
      operationID: "operation",
      revision: "revision",
      replacing: [],
      keeping: [.codex]
    ) { event in
      await recorder.append(event)
    }
    #expect(result.status == .complete)
    #expect(await recorder.events.map(\.phase) == ["connector:codex.verify"])
    #expect(await process.arguments.suffix(3) == ["--keep", "codex", "--events"])
  }

  @MainActor
  @Test("applying does not relaunch until the caller says the outcome is on screen")
  func relaunchIsDeferredUntilAfterCompletion() async {
    // The relaunch terminates the process. Running it inside `apply` meant the view never reached
    // `onFinished`, so the popover stayed on a half-finished setup until it was reopened.
    let runner = FixtureSetupRunner()
    let store = SetupStore(runner: runner, detector: FixtureDetector(detected: [.codex]))
    await store.prepare()
    await store.review()
    await store.apply()

    #expect(store.completion?.status == .complete)
    #expect(store.pendingApplicationRelaunch)
    #expect(await runner.relaunchCalls == 0)

    await store.relaunchInstalledApplicationIfNeeded()
    #expect(await runner.relaunchCalls == 1)
    #expect(!store.pendingApplicationRelaunch)

    // Asking twice must not restart the app again.
    await store.relaunchInstalledApplicationIfNeeded()
    #expect(await runner.relaunchCalls == 1)
  }

  @MainActor
  @Test("a Mac with no detected agent can still install the service")
  func noDetectedAgentStillReviewable() async {
    // EC-1 and the "successful setup with no supported agents" metric. The confirmation button was
    // gated on a non-empty selection, so nothing could be installed on such a machine at all.
    let store = SetupStore(runner: FixtureSetupRunner(), detector: FixtureDetector(detected: []))
    await store.prepare()
    #expect(store.agents.allSatisfy { !$0.detected })
    #expect(store.selectedAgents.isEmpty)
    #expect(store.canReview)

    let runner = FixtureSetupRunner()
    let planned = SetupStore(runner: runner, detector: FixtureDetector(detected: []))
    await planned.prepare()
    await planned.review()
    // The plan is requested with an empty connector list, and the service still installs.
    #expect(await runner.plannedSelections == [[]])
    await planned.apply()
    #expect(planned.service.state == .connected)
  }

  @MainActor
  @Test("selects detected agents by default and keeps service and agent outcomes separate")
  func defaultSelectionAndResult() async {
    let runner = FixtureSetupRunner()
    let store = SetupStore(
      runner: runner,
      detector: FixtureDetector(detected: [.codex])
    )
    await store.prepare()
    #expect(store.agents.first(where: { $0.id == .codex })?.selected == true)
    #expect(store.agents.first(where: { $0.id == .claudeCode })?.selected == false)
    #expect(store.canReview)
    // Deselecting every agent must not block setup. The spec's success metrics require a setup with
    // no supported agents to complete, and this assertion used to demand the opposite.
    store.setSelected(false, for: .codex)
    #expect(store.selectedAgents.isEmpty)
    #expect(store.canReview)
    store.setSelected(true, for: .codex)
    await store.review()
    await store.apply()
    #expect(store.service.state == .connected)
    #expect(store.agentResults.first?.state == .newSessionRequired)
    #expect(store.agentResults.first?.configured == true)
    #expect(store.agentResults.first?.available == true)
    #expect(await runner.plannedSelections == [[.codex]])
  }

  @MainActor
  @Test("retries only the failed agent while preserving the verified result")
  func focusedRetry() async {
    let runner = FixtureSetupRunner()
    await runner.setApplyResponse(
      SetupResult(
        status: .partial,
        service: SetupServiceResult(installed: true, running: true, verified: true),
        connectors: [
          SetupConnectorResult(
            id: .codex, configured: true, available: true, newSessionRequired: false,
            state: "connected", error: nil),
          SetupConnectorResult(
            id: .claudeCode, configured: true, available: false, newSessionRequired: false,
            state: "needsRepair", error: "Unavailable"),
        ],
        nextAction: .retry
      ))
    await runner.setRetryResponse(
      SetupResult(
        status: .complete,
        service: SetupServiceResult(installed: true, running: true, verified: true),
        connectors: [
          SetupConnectorResult(
            id: .codex, configured: true, available: true, newSessionRequired: false,
            state: "connected", error: nil),
          SetupConnectorResult(
            id: .claudeCode, configured: true, available: true, newSessionRequired: false,
            state: "connected", error: nil),
        ],
        nextAction: .done
      ))
    let store = SetupStore(
      runner: runner,
      detector: FixtureDetector(detected: [.codex, .claudeCode])
    )
    await store.prepare()
    await store.review()
    await store.apply()
    #expect(store.agentResults.first(where: { $0.id == .codex })?.available == true)
    #expect(store.agentResults.first(where: { $0.id == .claudeCode })?.state == .needsRepair)
    await store.retry(.claudeCode)
    #expect(store.agentResults.allSatisfy { $0.available })
    #expect(await runner.retryCalls == [.claudeCode])
  }

  @MainActor
  @Test("requires a separate redacted conflict decision before mutation")
  func conflictDecision() async {
    let runner = FixtureSetupRunner()
    await runner.setPlannedConflicts([
      SetupConflict(
        connectorId: .codex,
        comparison: "Existing route secret=private-value /Users/example/config"
      )
    ])
    let store = SetupStore(
      runner: runner,
      detector: FixtureDetector(detected: [.codex])
    )
    await store.prepare()
    await store.review()
    #expect(store.unresolvedConflicts.count == 1)
    #expect(await runner.applyCalls == 0)
    #expect(!SetupStore.sanitize(store.unresolvedConflicts[0].comparison).contains("private-value"))
    await store.resolveConflict(.codex, decision: .keep)
    #expect(await runner.applyCalls == 1)
    #expect(await runner.lastKeeping == [.codex])
    #expect(await runner.lastReplacing.isEmpty)
  }

  @MainActor
  @Test("resumes the durable operation after the store is recreated")
  func resumesDurableJournal() async {
    let runner = FixtureSetupRunner()
    await runner.setJournal(Self.runningJournal)
    let store = SetupStore(runner: runner, detector: FixtureDetector(detected: []))
    await store.resume()
    #expect(await runner.resumeCalls == 1)
    #expect(store.completion?.status == .complete)
  }

  @MainActor
  @Test("rehydrates a completed journal without rerunning its durable transaction")
  func rehydratesCompletedJournal() async {
    let runner = FixtureSetupRunner()
    await runner.setJournal(
      SetupJournal(
        schemaVersion: 1,
        operationId: "operation-1",
        revision: "revision-1",
        phase: "complete",
        selectedConnectors: [.codex],
        completedPhases: ["runtime.install", "service.verify", "connector:codex.verify"],
        diagnostics: [],
        service: SetupServiceResult(installed: true, running: true, verified: true),
        connectors: FixtureSetupRunner.success.connectors,
        loginItem: "enabled",
        status: .complete,
        updatedAt: "2026-08-31T10:00:00.000Z"
      ))
    let store = SetupStore(runner: runner, detector: FixtureDetector(detected: []))
    await store.resume()
    #expect(await runner.resumeCalls == 0)
    #expect(store.completion?.status == .complete)
    #expect(store.completion?.nextAction == .newSession)
    #expect(store.agentResults.first?.state == .newSessionRequired)
  }

  @Test("sanitizes credentials, private home paths and arbitrary multiline output")
  func sanitizesErrors() {
    let value = SetupStore.sanitize(
      "Authorization: Bearer private-value\nsecret=also-private /Users/example/project"
    )
    #expect(!value.contains("private-value"))
    #expect(!value.contains("also-private"))
    #expect(!value.contains("/Users/example"))
    #expect(!value.contains("\n"))
    #expect(value.count <= SetupStore.maximumErrorLength + 1)
  }

  @Test("decodes the indented envelope the packaged CLI emits for setup plan")
  func decodesIndentedPlanEnvelope() throws {
    // `setup plan` has no `--events` mode, so it always leaves the CLI through `printEnvelope`,
    // which indents with two spaces. Decoding must not assume one event per line.
    let source = """
      {
        "data": {
          "operationId": "d1d0678a-afef-4c36-b95a-35bd8dcdf9c1",
          "selectedConnectors": [],
          "changes": [
            {
              "kind": "runtime",
              "summary": "Install the private Pimpampum runtime."
            }
          ],
          "conflicts": [],
          "requiresConfirmation": true,
          "revision": "17a91022c05bd35d574db1b7f2d9b79c156a6558fa1f4f67686059bc6f4706e8"
        }
      }
      """
    let events = try SetupNDJSONDecoder.decode(Data(source.utf8))
    #expect(events.count == 1)
    guard case .plan(let plan) = events.last else {
      Issue.record("Expected one plan event")
      return
    }
    #expect(plan.operationId == "d1d0678a-afef-4c36-b95a-35bd8dcdf9c1")
    #expect(plan.requiresConfirmation)
    #expect(plan.changes.count == 1)
  }

  @Test("decodes the indented empty journal envelope from setup status")
  func decodesIndentedEmptyJournalEnvelope() throws {
    let source = """
      {
        "data": null
      }
      """
    let events = try SetupNDJSONDecoder.decode(Data(source.utf8))
    #expect(events.count == 1)
    guard case .journal(let journal) = events.last else {
      Issue.record("Expected one journal event")
      return
    }
    #expect(journal == nil)
  }

  @Test("reading the durable journal on launch must not look like a mutation")
  @MainActor
  func journalReadDoesNotBeginMutation() async {
    // `start()` always calls `resume()`. On a clean machine there is no journal, so nothing may be
    // reported as begun: the onboarding sends itself to its final step on `hasBegunMutation` and
    // never returns.
    let runner = ActivityProbeRunner()
    let store = SetupStore(runner: runner, detector: FixtureDetector(detected: []))
    runner.store = store
    await store.resume()
    #expect(!runner.activityDuringStatus.hasBegunMutation)
    #expect(runner.resumeCalls == 0)
    #expect(!store.activity.hasBegunMutation)
  }

  private static let runningJournal = SetupJournal(
    schemaVersion: 1,
    operationId: "operation-1",
    revision: "revision-1",
    phase: "connector:codex.verify",
    selectedConnectors: [.codex],
    completedPhases: ["runtime.install", "service.verify"],
    diagnostics: [],
    service: SetupServiceResult(installed: true, running: true, verified: true),
    connectors: [],
    loginItem: "enabled",
    status: .running,
    updatedAt: "2026-08-31T10:00:00.000Z"
  )
}

extension FixtureSetupRunner {
  fileprivate func setJournal(_ value: SetupJournal?) { journal = value }
  fileprivate func setApplyResponse(_ value: SetupResult) { applyResponse = value }
  fileprivate func setRetryResponse(_ value: SetupResult) { retryResponse = value }
  fileprivate func setPlannedConflicts(_ value: [SetupConflict]) { plannedConflicts = value }
}
