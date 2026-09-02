import Combine
import Foundation
import Testing

@testable import PimpampumMenuBar

/// The setup session belongs to the app. It keeps the store and the step alive across every poll
/// and every body swap of the popover, and it is the one place that moves between steps.
@Suite("Setup session")
@MainActor
struct SetupSessionTests {
  private func session(
    runner: ScriptedSetupRunner = ScriptedSetupRunner(),
    detected: Set<SetupAgentID> = [.codex],
    overviewStore: OverviewStore? = nil,
    registerLoginItem: @escaping @MainActor () -> Void = {}
  ) -> SetupSession {
    SetupSession(
      store: SetupStore(
        runner: runner,
        detector: StubAgentDetector(detected: detected),
        clock: ImmediateSetupClock()
      ),
      overviewStore: overviewStore,
      registerLoginItem: registerLoginItem
    )
  }

  @Test
  func opensOnTheFirstStepAndIsNotASessionUntilTheUserMovesOn() {
    let session = session()
    #expect(session.step == SetupOnboardingStep.first)
    #expect(!session.isActive)
    session.move(to: .explain)
    #expect(session.isActive)
    session.move(to: SetupOnboardingStep.first)
    #expect(!session.isActive)
  }

  @Test
  func staysActiveWhileAMutationRunsAndWhileAnOutcomeIsOnScreen() async {
    let runner = ScriptedSetupRunner()
    let gate = SetupGate()
    await runner.setApplyGate(gate)
    let session = session(runner: runner)
    await session.store.prepare()
    await session.store.review()
    session.move(to: .agents)

    let apply = Task { await session.reviewAndSetUp() }
    #expect(await eventually { await MainActor.run { session.store.activity == .applying } })
    #expect(session.step == .progress)
    #expect(session.isActive)

    await gate.open()
    await apply.value
    #expect(session.store.completion?.status == .complete)
    // The step is the first one only after Done; the outcome keeps the session alive until then.
    #expect(session.isActive)
    #expect(await runner.applyCalls.count == 1)
  }

  @Test
  func pausesOverviewPollingForTheMutationAndResumesWithARefresh() async {
    // A poll landing mid-apply reported a half-installed daemon and its answer replaced the
    // onboarding. Polling now waits for the mutation and refreshes as soon as it ends.
    let reader = SequenceOverviewReader(Array(repeating: .success(testOverview()), count: 4))
    let clock = RecordingOverviewClock(date: Date())
    let overview = OverviewStore(reader: reader, clock: clock)
    overview.start()
    #expect(await eventually { await reader.callCount == 1 })

    let runner = ScriptedSetupRunner()
    let gate = SetupGate()
    await runner.setApplyGate(gate)
    let session = session(runner: runner, overviewStore: overview)
    await session.store.prepare()
    await session.store.review()
    let apply = Task { await session.reviewAndSetUp() }
    #expect(await eventually { await MainActor.run { overview.isPollingPaused } })

    await gate.open()
    await apply.value
    #expect(!overview.isPollingPaused)
    #expect(await eventually { await reader.callCount == 2 })
    overview.stop()
  }

  @Test
  func republishesEveryStoreChange() async {
    // Views observe the session; a store change that did not reach them left stale rows.
    let session = session()
    var changes = 0
    let subscription = session.objectWillChange.sink { _ in changes += 1 }
    defer { subscription.cancel() }
    await session.store.prepare()
    #expect(changes > 0)
  }

  @Test
  func showsTheFinalStepAsSoonAsADurableJournalIsRunning() async {
    let runner = ScriptedSetupRunner()
    await runner.setStatusResults([
      .success(SetupFixtures.journal(status: .running)),
      .success(SetupFixtures.journal(status: .complete, connectors: [SetupFixtures.connector(.codex)])),
    ])
    let session = session(runner: runner, detected: [])
    session.begin()
    #expect(await eventually { await MainActor.run { session.step == .progress } })
    #expect(await eventually { await MainActor.run { session.store.completion != nil } })
    #expect(session.isActive)
    #expect(await runner.resumeCalls == 0)
    // Beginning twice does not start a second launch task.
    session.begin()
    #expect(await runner.statusCalls == 2)
  }

  @Test
  func confirmationNeedsAPlanAndAppliesOnlyWithoutConflicts() async {
    let runner = ScriptedSetupRunner()
    let session = session(runner: runner)
    session.move(to: .agents)
    // No plan yet: nothing happens.
    await session.reviewAndSetUp()
    #expect(session.step == .agents)
    #expect(await runner.applyCalls.isEmpty)

    await runner.setPlanResult(
      .success(
        SetupFixtures.plan(
          conflicts: [SetupConflict(connectorId: .codex, comparison: "differs")])))
    await session.store.prepare()
    await session.store.review()
    await session.reviewAndSetUp()
    // The conflict decision comes first; applying waits for it.
    #expect(session.step == .progress)
    #expect(await runner.applyCalls.isEmpty)
    session.cancelConflictRecovery()
    #expect(session.step == .agents)
    #expect(session.store.plan == nil)
  }

  @Test
  func startOverReturnsToTheFirstStepAfterAFailureButNeverMidMutation() async {
    let runner = ScriptedSetupRunner()
    await runner.setApplyResult(.success(SetupFixtures.result(status: .failed, nextAction: .retry)))
    let session = session(runner: runner)
    await session.store.prepare()
    await session.store.review()
    await session.reviewAndSetUp()
    #expect(session.store.completion?.status == .failed)
    #expect(session.step == .progress)

    session.startOver()
    #expect(session.step == SetupOnboardingStep.first)
    #expect(session.store.completion == nil)
    #expect(!session.isActive)

    let gate = SetupGate()
    await runner.setApplyGate(gate)
    await runner.setApplyResult(.success(SetupFixtures.completeResult))
    await session.store.review()
    let apply = Task { await session.reviewAndSetUp() }
    #expect(await eventually { await MainActor.run { session.store.activity == .applying } })
    session.startOver()
    #expect(session.step == .progress)
    await gate.open()
    await apply.value
  }

  @Test
  func finishRegistersTheLoginItemOnlyFromTheInstalledCopyAndRelaunchesLast() async {
    var registrations = 0
    let runner = ScriptedSetupRunner()
    let session = self.session(runner: runner, registerLoginItem: { registrations += 1 })
    await session.store.prepare()
    await session.store.review()
    await session.reviewAndSetUp()
    #expect(session.store.pendingApplicationRelaunch)

    await session.finish()
    #expect(registrations == 1)
    #expect(session.step == SetupOnboardingStep.first)
    #expect(session.store.completion == nil)
    #expect(!session.isActive)
    #expect(await runner.relaunchCalls == 1)

    // From a copy that is not the installed one, registering would name the transient bundle.
    let transient = ScriptedSetupRunner()
    transient.runsFromInstalledSnapshot = false
    var transientRegistrations = 0
    let transientSession = self.session(
      runner: transient, registerLoginItem: { transientRegistrations += 1 })
    await transientSession.finish()
    #expect(transientRegistrations == 0)
  }

  @Test
  func bundledSessionUsesThePackagedRuntimeWhenPresentAndStaysInertWithoutIt() async {
    let session = SetupSession.bundled(overviewStore: nil)
    #expect(!session.isActive)
    #expect(session.step == SetupOnboardingStep.first)
    // A session with no login-item hook finishes without one.
    let plain = SetupSession(store: SetupStore(runner: ScriptedSetupRunner()))
    await plain.finish()
    #expect(!plain.isActive)
  }
}
