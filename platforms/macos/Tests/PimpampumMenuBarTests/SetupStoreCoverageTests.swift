import Foundation
import Testing

@testable import PimpampumMenuBar

/// Every branch of the setup store: the file joined the coverage gate on 2026-09-01 after the
/// first-run defects of that session all sat in code the gate never measured.
@Suite("Setup store lifecycle")
@MainActor
struct SetupStoreCoverageTests {
  private func store(
    _ runner: ScriptedSetupRunner,
    detected: Set<SetupAgentID> = [.codex],
    clock: any OverviewClock = ImmediateSetupClock()
  ) -> SetupStore {
    SetupStore(runner: runner, detector: StubAgentDetector(detected: detected), clock: clock)
  }

  private func applied(
    _ runner: ScriptedSetupRunner,
    detected: Set<SetupAgentID> = [.codex]
  ) async -> SetupStore {
    let store = store(runner, detected: detected)
    await store.prepare()
    await store.review()
    await store.apply()
    return store
  }

  /// Drives `resume()` through a running journal that turns into `terminal` on the next read.
  private func rehydrated(
    running: SetupJournal = SetupFixtures.journal(status: .running),
    then terminal: SetupJournal
  ) async -> SetupStore {
    let runner = ScriptedSetupRunner()
    await runner.setStatusResults([.success(running), .success(terminal)])
    let store = store(runner, detected: [])
    await store.resume()
    return store
  }

  @Test
  func detectsAgentsByPresenceOnlyAndFollowsSymlinks() async throws {
    let home = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-detect-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: home) }
    let bin = home.appendingPathComponent(".local/bin", isDirectory: true)
    try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    // Codex installs as a symlink into ~/.local/bin; refusing links made it undetectable.
    let target = home.appendingPathComponent("codex-target")
    FileManager.default.createFile(atPath: target.path, contents: Data("bin".utf8))
    try FileManager.default.createSymbolicLink(
      at: bin.appendingPathComponent("codex"), withDestinationURL: target)
    // Claude as an application bundle directory.
    try FileManager.default.createDirectory(
      at: home.appendingPathComponent("Applications/Claude.app"), withIntermediateDirectories: true)
    let detected = await LocalSetupAgentDetector(homeDirectory: home).detect()
    #expect(detected.isSuperset(of: [.codex, .claudeCode]))

    let empty = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-detect-empty-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: empty) }
    try FileManager.default.createDirectory(
      at: empty.appendingPathComponent(".local/bin"), withIntermediateDirectories: true)
    // A dangling link is not an agent.
    try FileManager.default.createSymbolicLink(
      at: empty.appendingPathComponent(".local/bin/claude"),
      withDestinationURL: empty.appendingPathComponent("missing"))
    let none = await LocalSetupAgentDetector(homeDirectory: empty).detect()
    // The system-wide locations may exist on the machine running the suite; only the home ones are
    // under test here.
    #expect(!none.contains(.claudeCode) || FileManager.default.fileExists(atPath: "/Applications/Claude.app")
      || FileManager.default.fileExists(atPath: "/opt/homebrew/bin/claude")
      || FileManager.default.fileExists(atPath: "/usr/local/bin/claude"))
  }

  @Test
  func bundledStoreFallsBackToAnUnavailableRunnerWithoutAPackagedRuntime() async {
    // The test bundle has no embedded runtime, so the default lookup fails.
    let fallback = SetupStore.bundled()
    await fallback.review()
    #expect(fallback.errorMessage == SetupClientError.unavailable.message)
    #expect(fallback.canRegisterLoginItemFromThisProcess)

    let home = URL(fileURLWithPath: "/Users/example")
    let packaged = SetupStore.bundled {
      EmbeddedSetupBootstrap(
        runtime: EmbeddedControlRuntime(
          rootURL: home, executableURL: home.appendingPathComponent("node"),
          cliURL: home.appendingPathComponent("cli.js")),
        sourceApplicationURL: home.appendingPathComponent("Downloads/Pimpampum.app"),
        dataDirectory: home.appendingPathComponent(".pimpampum"),
        homeDirectory: home
      )
    }
    // A packaged runner from a Downloads copy knows it is not the installed one.
    #expect(!packaged.canRegisterLoginItemFromThisProcess)
  }

  @Test
  func theUnavailableRunnerRefusesEveryCommandAndNeverRelaunches() async throws {
    let runner = UnavailableSetupCommandRunner()
    await #expect(throws: SetupClientError.unavailable) { try await runner.plan(selectedConnectors: []) }
    await #expect(throws: SetupClientError.unavailable) {
      try await runner.apply(operationID: "o", revision: "r", replacing: [], keeping: []) { _ in }
    }
    await #expect(throws: SetupClientError.unavailable) { try await runner.status() }
    await #expect(throws: SetupClientError.unavailable) { try await runner.resume { _ in } }
    await #expect(throws: SetupClientError.unavailable) { try await runner.retry(.codex) { _ in } }
    #expect(try await runner.relaunchInstalledApplicationIfNeeded() == false)
    #expect(runner.runsFromInstalledApplication())
  }

  @Test
  func cancelledDetectionLeavesTheStoreIdleAndEmpty() async {
    let store = SetupStore(
      runner: ScriptedSetupRunner(), detector: SuspendingAgentDetector(), clock: ImmediateSetupClock())
    let task = Task { await store.prepare() }
    #expect(await eventually { await MainActor.run { store.activity == .detecting } })
    task.cancel()
    await task.value
    #expect(store.activity == .idle)
    #expect(store.agents.isEmpty)
    // Selecting before detection has produced rows is a no-op, not a crash.
    store.setSelected(true, for: .codex)
    #expect(store.selectedAgents.isEmpty)
  }

  @Test
  func everyOperationRefusesToStartWhileAnotherRuns() async {
    let runner = ScriptedSetupRunner()
    let gate = SetupGate()
    await runner.setPlanGate(gate)
    let store = store(runner)
    await store.prepare()
    let review = Task { await store.review() }
    #expect(await eventually { await MainActor.run { store.activity == .planning } })

    await store.prepare()
    await store.review()
    await store.apply()
    await store.retry(.codex)
    await store.resume()
    store.reset()
    #expect(store.activity == .planning)
    #expect(await runner.planCalls.count == 1)
    #expect(await runner.applyCalls.isEmpty)
    #expect(await runner.statusCalls == 0)

    await gate.open()
    await review.value
    #expect(store.plan != nil)
  }

  @Test
  func planningWaitsForTheLaunchTaskAndBailsOutWhenCancelled() async {
    // The agents step asks for a plan the moment it appears, often before `start()` has finished
    // detecting agents. Returning early left no plan and no error under the button.
    let runner = ScriptedSetupRunner()
    let store = SetupStore(
      runner: runner, detector: SuspendingAgentDetector(), clock: ImmediateSetupClock())
    store.start()
    let review = Task { await store.review() }
    try? await Task.sleep(for: .milliseconds(20))
    #expect(await runner.planCalls.isEmpty)
    review.cancel()
    await review.value
    // Cancelled while waiting: nothing is planned and no completion is wiped.
    #expect(await runner.planCalls.isEmpty)
    #expect(store.plan == nil)

    let quick = ScriptedSetupRunner()
    let ready = self.store(quick)
    let cancelled = Task { await ready.review() }
    cancelled.cancel()
    await cancelled.value
    #expect(await quick.planCalls.isEmpty)
  }

  @Test
  func planningResumesOnceTheLaunchTaskFinishes() async {
    let gate = SetupGate()
    let runner = ScriptedSetupRunner()
    let store = SetupStore(
      runner: runner, detector: GatedAgentDetector(gate: gate), clock: ImmediateSetupClock())
    store.start()
    let review = Task { await store.review() }
    try? await Task.sleep(for: .milliseconds(20))
    #expect(await runner.planCalls.isEmpty)
    // A review cancelled before it even started waiting returns at once.
    let alreadyCancelled = Task { await store.review() }
    alreadyCancelled.cancel()
    await alreadyCancelled.value

    await gate.open()
    await review.value
    #expect(await runner.planCalls == [[.codex]])
    #expect(store.plan != nil)
  }

  @Test
  func aStoreMayDeallocateBeforeItsLaunchTaskBegins() async {
    var store: SetupStore? = SetupStore(
      runner: ScriptedSetupRunner(), detector: StubAgentDetector(detected: []),
      clock: ImmediateSetupClock())
    store?.start()
    store = nil
    await Task.yield()
    #expect(store == nil)
  }

  @Test
  func resetNeverAbandonsAMutationInFlight() async {
    let runner = ScriptedSetupRunner()
    let gate = SetupGate()
    await runner.setApplyGate(gate)
    let store = store(runner)
    await store.prepare()
    await store.review()
    let apply = Task { await store.apply() }
    #expect(await eventually { await MainActor.run { store.activity == .applying } })
    store.reset()
    #expect(store.plan != nil)
    await gate.open()
    await apply.value
    #expect(store.completion?.status == .complete)
  }

  @Test
  func aConflictTheResultRepeatsIsListedOnce() async {
    // The store does not stop a direct apply while a conflict is undecided; the screens do. When
    // the CLI then reports the same conflict, it must not appear twice.
    let runner = ScriptedSetupRunner()
    await runner.setPlanResult(
      .success(
        SetupFixtures.plan(conflicts: [SetupConflict(connectorId: .codex, comparison: "differs")])))
    await runner.setApplyResult(
      .success(
        SetupFixtures.result(
          status: .conflict,
          connectors: [SetupFixtures.connector(.codex, state: "conflict")],
          nextAction: .resolveConflict)))
    let store = await applied(runner)
    #expect(store.unresolvedConflicts.map(\.connectorId) == [.codex])
    #expect(store.unresolvedConflicts.first?.comparison == "differs")
  }

  @Test
  func planningReportsEveryKindOfFailure() async {
    let runner = ScriptedSetupRunner()
    let store = store(runner)
    await store.prepare()

    await runner.setPlanResult(.failure(CancellationError()))
    await store.review()
    #expect(store.errorMessage == SetupClientError.cancelled.message)
    #expect(!store.canConfirm)

    await runner.setPlanResult(.failure(SetupClientError.commandFailed("Bearer secret /Users/x/y")))
    await store.review()
    #expect(store.errorMessage == "[credential redacted] ~/y")

    await runner.setPlanResult(.failure(SetupTestError()))
    await store.review()
    #expect(store.errorMessage?.isEmpty == false)

    await runner.setPlanResult(.success(SetupFixtures.plan()))
    await store.review()
    #expect(store.errorMessage == nil)
    #expect(store.canConfirm)
  }

  @Test
  func applyingNeedsAPlanAndReportsFailures() async {
    let runner = ScriptedSetupRunner()
    let store = store(runner)
    await store.prepare()
    await store.apply()
    #expect(await runner.applyCalls.isEmpty)

    await store.review()
    await runner.setApplyResult(.failure(SetupClientError.responseTooLarge))
    await store.apply()
    #expect(store.errorMessage == SetupClientError.responseTooLarge.message)
    #expect(store.completion == nil)

    await runner.setApplyResult(.failure(SetupTestError()))
    await store.apply()
    #expect(store.errorMessage?.isEmpty == false)
    #expect(!store.pendingApplicationRelaunch)
  }

  @Test
  func progressEventsUpdateTheServiceAndOnlyKnownAgents() async {
    let runner = ScriptedSetupRunner()
    await runner.setApplyEvents([
      SetupFixtures.event(phase: "runtime.install", status: .started),
      SetupFixtures.event(phase: "service.install", status: .started),
      SetupFixtures.event(phase: "service.verify", status: .failed, diagnostic: "no answer"),
      SetupFixtures.event(phase: "connector:claude-code.write", status: .started, connectorId: .claudeCode),
      SetupFixtures.event(phase: "connector:codex.write", status: .started, connectorId: .codex),
      SetupFixtures.event(phase: "connector:codex.write", status: .completed, connectorId: .codex),
      SetupFixtures.event(phase: "connector:codex.verify", status: .failed, connectorId: .codex),
      SetupFixtures.event(
        phase: "connector:codex.verify", status: .failed, connectorId: .codex,
        diagnostic: "token=secret refused"),
    ])
    await runner.setApplyResult(
      .success(
        SetupFixtures.result(
          status: .partial,
          service: SetupServiceResult(installed: true, running: false, verified: false),
          connectors: [
            SetupFixtures.connector(.codex, available: false, state: "needs-repair", error: "refused")
          ],
          nextAction: .retry)))
    let store = await applied(runner)
    #expect(store.progress.count == 8)
    #expect(store.service.state == .unavailable)
    #expect(store.agentResults.map(\.id) == [.codex])
    #expect(store.agentResults.first?.state == .needsRepair)
    #expect(store.agentResults.first?.error == "refused")
  }

  @Test
  func focusedRetryRunsOnlyForAKnownBrokenAgentAndReportsFailures() async {
    let runner = ScriptedSetupRunner()
    await runner.setApplyResult(
      .success(
        SetupFixtures.result(
          status: .partial,
          connectors: [
            SetupFixtures.connector(.codex),
            SetupFixtures.connector(.claudeCode, available: false, state: "needs-repair"),
          ],
          nextAction: .retry)))
    let store = await applied(runner, detected: [.codex, .claudeCode])
    // Unknown or healthy agents are not retried.
    await store.retry(.codex)
    #expect(await runner.retryCalls.isEmpty)

    await runner.setRetryResult(.failure(SetupClientError.invalidResponse))
    await store.retry(.claudeCode)
    #expect(await runner.retryCalls == [.claudeCode])
    #expect(store.errorMessage == SetupClientError.invalidResponse.message)

    await runner.setRetryResult(.failure(SetupTestError()))
    await store.retry(.claudeCode)
    #expect(store.errorMessage?.isEmpty == false)

    await runner.setRetryResult(.success(SetupFixtures.result(status: .complete, connectors: [
      SetupFixtures.connector(.codex), SetupFixtures.connector(.claudeCode),
    ])))
    await runner.setRetryEvents([
      SetupFixtures.event(phase: "connector:claude-code.verify", status: .started, connectorId: .claudeCode)
    ])
    await store.retry(.claudeCode)
    #expect(store.errorMessage == nil)
    #expect(store.progress.last?.connectorId == .claudeCode)
    #expect(store.agentResults.allSatisfy { $0.available })
    #expect(store.pendingApplicationRelaunch)
    // Nothing broken remains, so a further retry is a no-op.
    await store.retry(.claudeCode)
    #expect(await runner.retryCalls.count == 3)
  }

  @Test
  func conflictsFromThePlanAndTheResultAreMergedAndDecidedOneByOne() async {
    let runner = ScriptedSetupRunner()
    await runner.setPlanResult(
      .success(
        SetupFixtures.plan(
          selected: [.codex, .claudeCode],
          conflicts: [
            SetupConflict(connectorId: .codex, comparison: "differs"),
            SetupConflict(connectorId: .claudeCode, comparison: "differs"),
          ])))
    await runner.setApplyResult(
      .success(
        SetupFixtures.result(
          status: .conflict,
          connectors: [
            SetupFixtures.connector(.codex, state: "conflict"),
            SetupFixtures.connector(.claudeCode, state: "connected"),
          ],
          nextAction: .resolveConflict)))
    let store = store(runner, detected: [.codex, .claudeCode])
    await store.prepare()
    await store.review()
    #expect(store.unresolvedConflicts.count == 2)

    await store.resolveConflict(.codex, decision: .replace)
    #expect(await runner.applyCalls.isEmpty)
    // Deciding twice for the same agent changes nothing.
    await store.resolveConflict(.codex, decision: .keep)
    #expect(await runner.applyCalls.isEmpty)

    await store.resolveConflict(.claudeCode, decision: .keep)
    #expect(await runner.applyCalls.count == 1)
    #expect(await runner.applyCalls.first?.replacing == [.codex])
    #expect(await runner.applyCalls.first?.keeping == [.claudeCode])
    // The result still reports a conflict for codex: it is listed once, not twice.
    #expect(store.unresolvedConflicts.map(\.connectorId) == [.codex])
    #expect(store.agentResults.first(where: { $0.id == .codex })?.state == .configurationConflict)

    store.reset()
    #expect(store.unresolvedConflicts.isEmpty)
    #expect(store.plan == nil)
    #expect(store.completion == nil)
    #expect(store.agentResults.isEmpty)
    #expect(store.service.state == .notInstalled)
  }

  @Test
  func rehydrationReportsStatusFailures() async {
    let runner = ScriptedSetupRunner()
    await runner.setStatusResults([.failure(SetupClientError.incompatibleSchema)])
    let store = store(runner, detected: [])
    await store.resume()
    #expect(store.errorMessage == SetupClientError.incompatibleSchema.message)

    await runner.setStatusResults([.failure(SetupTestError())])
    await store.resume()
    #expect(store.errorMessage?.isEmpty == false)
  }

  @Test
  func aRunningJournalShowsItsAgentsConnectingUntilItEnds() async {
    let running = SetupFixtures.journal(
      status: .running,
      selected: [.codex, .claudeCode],
      connectors: [SetupFixtures.connector(.codex), SetupFixtures.connector(.codex)])
    let complete = SetupFixtures.journal(
      status: .complete,
      selected: [.codex, .claudeCode],
      connectors: [SetupFixtures.connector(.codex, newSessionRequired: true)],
      updatedAt: "2026-08-31T10:00:09.000Z")
    let runner = ScriptedSetupRunner()
    await runner.setStatusResults([.success(running), .success(complete)])
    let clock = ControllableOverviewClock(date: Date())
    let store = store(runner, detected: [], clock: clock)
    let task = Task { await store.resume() }
    #expect(await eventually { await clock.hasSleeper })
    // Following another process's journal is a mutation in progress for the screens.
    #expect(store.activity == .resuming)
    #expect(store.agentResults.map(\.state) == [.connected, .connecting])
    await clock.resumeSleep()
    await task.value
    #expect(store.completion?.nextAction == .newSession)
    // The agent without a result is not connected once the journal is final.
    #expect(store.agentResults.first(where: { $0.id == .claudeCode })?.state == .notConnected)
    #expect(store.agentResults.first(where: { $0.id == .codex })?.state == .newSessionRequired)
  }

  @Test
  func aJournalThatDisappearsWhileFollowedLeavesNothingOnScreen() async {
    let runner = ScriptedSetupRunner()
    await runner.setStatusResults([.success(SetupFixtures.journal(status: .running)), .success(nil)])
    let store = store(runner, detected: [])
    await store.resume()
    #expect(store.completion == nil)
    #expect(store.agentResults.isEmpty)
    #expect(store.service.state == .notInstalled)
    #expect(await runner.resumeCalls == 0)
  }

  @Test
  func aJournalThatKeepsMovingIsNotTakenOver() async {
    // `updatedAt` advancing means the owner is alive; only a stalled journal is resumed here.
    var journals: [Result<SetupJournal?, any Error>] = []
    for index in 0..<(SetupStore.stalledJournalPollLimit + 5) {
      journals.append(
        .success(SetupFixtures.journal(status: .running, updatedAt: "2026-08-31T10:00:\(String(format: "%02d", index)).000Z")))
    }
    journals.append(.success(SetupFixtures.journal(status: .complete, connectors: [SetupFixtures.connector(.codex)])))
    let runner = ScriptedSetupRunner()
    await runner.setStatusResults(journals)
    let store = store(runner, detected: [])
    await store.resume()
    #expect(await runner.resumeCalls == 0)
    #expect(store.completion?.status == .complete)
  }

  @Test
  func takingOverAStalledJournalStreamsItsProgressAndReportsFailures() async {
    let runner = ScriptedSetupRunner()
    await runner.setStatusResults([.success(SetupFixtures.journal(status: .running))])
    await runner.setResumeEvents([
      SetupFixtures.event(phase: "connector:codex.verify", status: .completed, connectorId: .codex)
    ])
    let streamed = store(runner, detected: [])
    await streamed.resume()
    #expect(streamed.progress.map(\.phase) == ["connector:codex.verify"])
    #expect(streamed.completion?.status == .complete)

    await runner.setStatusResults([.success(SetupFixtures.journal(status: .running))])
    await runner.setResumeResult(.failure(SetupClientError.commandFailed("lock busy")))
    let store = store(runner, detected: [])
    await store.resume()
    #expect(await runner.resumeCalls == 2)
    #expect(store.errorMessage == "lock busy")
  }

  @Test
  func cancellationWhileFollowingAJournalIsSilent() async {
    let runner = ScriptedSetupRunner()
    await runner.setStatusResults([.success(SetupFixtures.journal(status: .running))])
    let store = store(runner, detected: [], clock: SystemOverviewClock())
    let task = Task { await store.resume() }
    #expect(await eventually { await MainActor.run { store.activity == .resuming } })
    task.cancel()
    await task.value
    #expect(store.errorMessage == nil)
    #expect(store.activity == .idle)
  }

  @Test
  func aFinalJournalCarriesItsNextAction() async {
    let codex = SetupFixtures.connector(.codex)
    let conflict = await rehydrated(then: SetupFixtures.journal(status: .conflict, connectors: [codex]))
    #expect(conflict.completion?.status == .conflict)
    #expect(conflict.completion?.nextAction == .resolveConflict)

    let partial = await rehydrated(then: SetupFixtures.journal(status: .partial, connectors: [codex]))
    #expect(partial.completion?.status == .partial)
    #expect(partial.completion?.nextAction == .retry)

    let failed = await rehydrated(
      then: SetupFixtures.journal(status: .failed, connectors: [codex], diagnostics: ["disk full", "Bearer x"]))
    #expect(failed.completion?.nextAction == .retry)
    #expect(failed.errorMessage == "[credential redacted]")

    let silentFailure = await rehydrated(then: SetupFixtures.journal(status: .failed, connectors: [codex]))
    #expect(silentFailure.errorMessage == nil)

    let approval = await rehydrated(
      then: SetupFixtures.journal(status: .complete, connectors: [codex], loginItem: "requires-approval"))
    #expect(approval.completion?.nextAction == .recoverLoginItem)
    #expect(approval.needsLoginItemApproval)

    let denied = await rehydrated(
      then: SetupFixtures.journal(status: .complete, connectors: [codex], loginItem: "denied"))
    #expect(denied.completion?.nextAction == .recoverLoginItem)

    let done = await rehydrated(then: SetupFixtures.journal(status: .complete, connectors: [codex]))
    #expect(done.completion?.nextAction == .done)
  }

  @Test
  func presentsServiceAndAgentStatesFromTheirRawResults() async {
    let states: [(SetupConnectorResult, SetupComponentState)] = [
      (SetupFixtures.connector(.codex, state: "Configuration-Conflict"), .configurationConflict),
      (SetupFixtures.connector(.codex, state: "unsupported-version"), .unsupportedVersion),
      (SetupFixtures.connector(.codex, newSessionRequired: true), .newSessionRequired),
      (SetupFixtures.connector(.codex), .connected),
      (SetupFixtures.connector(.codex, available: false), .needsRepair),
      (SetupFixtures.connector(.codex, configured: false, available: false, state: "needs-repair"), .needsRepair),
      (SetupFixtures.connector(.codex, configured: false, available: false, state: "missing", error: "/Users/x/y"), .notConnected),
    ]
    for (connector, expected) in states {
      let store = await rehydrated(then: SetupFixtures.journal(status: .complete, connectors: [connector]))
      #expect(store.agentResults.first?.state == expected)
    }
    let last = await rehydrated(
      then: SetupFixtures.journal(status: .complete, connectors: [states.last!.0]))
    #expect(last.agentResults.first?.error == "~/y")

    let unverified = await rehydrated(
      then: SetupFixtures.journal(
        status: .failed, service: SetupServiceResult(installed: true, running: false, verified: false)))
    #expect(unverified.service.state == .unavailable)
    let absent = await rehydrated(
      then: SetupFixtures.journal(
        status: .failed, service: SetupServiceResult(installed: false, running: false, verified: false)))
    #expect(absent.service.state == .notInstalled)
  }

  @Test
  func sanitizedMessagesAreNeverEmptyAndAlwaysBounded() {
    #expect(SetupStore.sanitize("  \n\t ") == "Setup could not finish. Retry from Pimpampum.")
    let long = SetupStore.sanitize(String(repeating: "x", count: 600))
    #expect(long.count == SetupStore.maximumErrorLength + 1)
    #expect(long.hasSuffix("…"))
  }
}
