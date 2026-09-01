import Foundation

@testable import PimpampumMenuBar

/// Lets a test hold a fixture call open until it has observed the store mid-operation.
actor SetupGate {
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var isOpen = false

  func wait() async {
    guard !isOpen else { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true
    let pending = waiters
    waiters = []
    for waiter in pending { waiter.resume() }
  }
}

struct StubAgentDetector: SetupAgentDetecting {
  let detected: Set<SetupAgentID>
  func detect() async -> Set<SetupAgentID> { detected }
}

/// Detection that answers once the test opens its gate.
struct GatedAgentDetector: SetupAgentDetecting {
  let gate: SetupGate
  func detect() async -> Set<SetupAgentID> {
    await gate.wait()
    return [.codex]
  }
}

/// Detection that never answers on its own; only cancellation ends it.
struct SuspendingAgentDetector: SetupAgentDetecting {
  func detect() async -> Set<SetupAgentID> {
    try? await Task.sleep(for: .seconds(3_600))
    return []
  }
}

/// A `SetupCommandRunning` whose every answer is scripted, including failures, streamed progress
/// events and a sequence of journals for successive `setup status` reads.
actor ScriptedSetupRunner: SetupCommandRunning {
  var planResult: Result<SetupPlan, any Error> = .success(SetupFixtures.plan())
  var applyResult: Result<SetupResult, any Error> = .success(SetupFixtures.completeResult)
  var resumeResult: Result<SetupResult, any Error> = .success(SetupFixtures.completeResult)
  var retryResult: Result<SetupResult, any Error> = .success(SetupFixtures.completeResult)
  var statusResults: [Result<SetupJournal?, any Error>] = [.success(nil)]
  var applyEvents: [SetupProgressEvent] = []
  var resumeEvents: [SetupProgressEvent] = []
  var retryEvents: [SetupProgressEvent] = []
  var planGate: SetupGate?
  var applyGate: SetupGate?
  var runsFromInstalled = true

  private(set) var planCalls: [[SetupAgentID]] = []
  private(set) var applyCalls: [(replacing: [SetupAgentID], keeping: [SetupAgentID])] = []
  private(set) var statusCalls = 0
  private(set) var resumeCalls = 0
  private(set) var retryCalls: [SetupAgentID] = []
  private(set) var relaunchCalls = 0

  func plan(selectedConnectors: [SetupAgentID]) async throws -> SetupPlan {
    planCalls.append(selectedConnectors)
    if let planGate { await planGate.wait() }
    return try planResult.get()
  }

  func apply(
    operationID _: String,
    revision _: String,
    replacing: [SetupAgentID],
    keeping: [SetupAgentID],
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    applyCalls.append((replacing, keeping))
    if let applyGate { await applyGate.wait() }
    for event in applyEvents { await onProgress(event) }
    return try applyResult.get()
  }

  func status() async throws -> SetupJournal? {
    statusCalls += 1
    let result = statusResults.count == 1 ? statusResults[0] : statusResults.removeFirst()
    return try result.get()
  }

  func resume(
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    resumeCalls += 1
    for event in resumeEvents { await onProgress(event) }
    return try resumeResult.get()
  }

  func retry(
    _ id: SetupAgentID,
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    retryCalls.append(id)
    for event in retryEvents { await onProgress(event) }
    return try retryResult.get()
  }

  @MainActor
  func relaunchInstalledApplicationIfNeeded() async throws -> Bool {
    await recordRelaunch()
    return true
  }

  @MainActor
  func runsFromInstalledApplication() -> Bool {
    // Synchronous protocol requirement; the flag is set before the store is created.
    runsFromInstalledSnapshot
  }

  nonisolated(unsafe) var runsFromInstalledSnapshot = true

  private func recordRelaunch() { relaunchCalls += 1 }

  func setPlanResult(_ value: Result<SetupPlan, any Error>) { planResult = value }
  func setApplyResult(_ value: Result<SetupResult, any Error>) { applyResult = value }
  func setResumeResult(_ value: Result<SetupResult, any Error>) { resumeResult = value }
  func setRetryResult(_ value: Result<SetupResult, any Error>) { retryResult = value }
  func setStatusResults(_ values: [Result<SetupJournal?, any Error>]) { statusResults = values }
  func setApplyEvents(_ values: [SetupProgressEvent]) { applyEvents = values }
  func setResumeEvents(_ values: [SetupProgressEvent]) { resumeEvents = values }
  func setRetryEvents(_ values: [SetupProgressEvent]) { retryEvents = values }
  func setPlanGate(_ gate: SetupGate?) { planGate = gate }
  func setApplyGate(_ gate: SetupGate?) { applyGate = gate }
}

struct SetupTestError: Error {}

enum SetupFixtures {
  static func plan(
    selected: [SetupAgentID] = [.codex],
    conflicts: [SetupConflict] = []
  ) -> SetupPlan {
    SetupPlan(
      operationId: "operation-1",
      revision: "revision-1",
      selectedConnectors: selected,
      changes: [SetupChange(kind: "service", summary: "Install the background service", path: nil)],
      conflicts: conflicts,
      requiresConfirmation: true
    )
  }

  static func connector(
    _ id: SetupAgentID,
    configured: Bool = true,
    available: Bool = true,
    newSessionRequired: Bool = false,
    state: String = "connected",
    error: String? = nil
  ) -> SetupConnectorResult {
    SetupConnectorResult(
      id: id,
      configured: configured,
      available: available,
      newSessionRequired: newSessionRequired,
      state: state,
      error: error
    )
  }

  static let installedService = SetupServiceResult(installed: true, running: true, verified: true)

  static let completeResult = SetupResult(
    status: .complete,
    service: installedService,
    connectors: [connector(.codex)],
    nextAction: .done
  )

  static func result(
    status: SetupCompletionStatus,
    service: SetupServiceResult = installedService,
    connectors: [SetupConnectorResult] = [connector(.codex)],
    nextAction: SetupNextAction = .done
  ) -> SetupResult {
    SetupResult(status: status, service: service, connectors: connectors, nextAction: nextAction)
  }

  static func journal(
    status: SetupJournalStatus,
    selected: [SetupAgentID] = [.codex],
    connectors: [SetupConnectorResult] = [],
    service: SetupServiceResult = installedService,
    loginItem: String = "enabled",
    diagnostics: [String] = [],
    updatedAt: String = "2026-08-31T10:00:00.000Z"
  ) -> SetupJournal {
    SetupJournal(
      schemaVersion: 1,
      operationId: "operation-1",
      revision: "revision-1",
      phase: status == .running ? "connector:codex.verify" : "complete",
      selectedConnectors: selected,
      completedPhases: ["runtime.install", "service.verify"],
      diagnostics: diagnostics,
      service: service,
      connectors: connectors,
      loginItem: loginItem,
      status: status,
      updatedAt: updatedAt
    )
  }

  static func event(
    phase: String,
    status: SetupProgressStatus,
    connectorId: SetupAgentID? = nil,
    diagnostic: String? = nil
  ) -> SetupProgressEvent {
    SetupProgressEvent(
      schemaVersion: 1,
      operationId: "operation-1",
      phase: phase,
      status: status,
      occurredAt: "2026-08-31T10:00:00.000Z",
      connectorId: connectorId,
      diagnostic: diagnostic
    )
  }
}
