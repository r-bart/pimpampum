import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
@MainActor
struct OverviewStoreTests {
  @Test
  func groupsAndSortsProjectsAndExpiresVisibleClaimsAgainstTheInjectedClock() async {
    let now = isoDate("2026-08-26T20:10:00.000Z")
    let projects = [
      testProject(id: "draft", status: .draft, updatedAt: now),
      testProject(id: "available-old", status: .available, updatedAt: now.addingTimeInterval(-20)),
      testProject(id: "complete-b", status: .complete, updatedAt: now),
      testProject(id: "active-z", status: .active, updatedAt: now),
      testProject(id: "available-new", status: .available, updatedAt: now),
      testProject(id: "complete-a", status: .complete, updatedAt: now),
      testProject(
        id: "cancelled-b", status: .complete, updatedAt: now,
        lifecycleState: .cancelled
      ),
      testProject(
        id: "cancelled-a", status: .complete, updatedAt: now,
        lifecycleState: .cancelled
      ),
      testProject(id: "paused", status: .paused, updatedAt: now),
      testProject(id: "active-a", status: .active, updatedAt: now),
    ]
    let work = [
      OverviewActiveWork(
        targetType: .spec,
        targetId: "expired-spec",
        workspaceId: "workspace",
        projectId: "active-a",
        projectTitle: "Active A",
        specId: "expired-spec",
        specTitle: "Expired spec",
        taskId: nil,
        taskTitle: nil,
        agentId: "old-agent",
        expiresAt: now
      ),
      OverviewActiveWork(
        targetType: .task,
        targetId: "live",
        workspaceId: "workspace",
        projectId: "active-z",
        projectTitle: "Active Z",
        specId: "live-spec",
        specTitle: "Live spec",
        taskId: "live",
        taskTitle: "Live task",
        agentId: "agent",
        expiresAt: now.addingTimeInterval(30)
      ),
    ]
    let clock = RecordingOverviewClock(date: now)
    let specs = [
      testSpec(
        id: "ready-old", lifecycleState: .ready,
        updatedAt: now.addingTimeInterval(-20)
      ),
      testSpec(id: "done-b", lifecycleState: .done, updatedAt: now),
      testSpec(id: "ready-new", lifecycleState: .ready, updatedAt: now),
      testSpec(id: "done-a", lifecycleState: .done, updatedAt: now),
      testSpec(id: "draft", lifecycleState: .draft, updatedAt: now),
      testSpec(
        id: "ready-paused-project", lifecycleState: .ready,
        projectLifecycleState: .paused, updatedAt: now
      ),
    ]
    let store = OverviewStore(
      reader: SequenceOverviewReader([
        .success(testOverview(projects: projects, specs: specs, activeWork: work))
      ]),
      clock: clock
    )

    await store.refresh()

    #expect(store.connectionState == .online)
    #expect(!store.isStale)
    #expect(
      store.incompleteProjects.map(\.id) == [
        "active-a", "active-z", "available-new", "available-old", "draft", "paused",
      ])
    #expect(store.completedProjects.map(\.id) == ["complete-a", "complete-b"])
    #expect(store.cancelledProjects.map(\.id) == ["cancelled-a", "cancelled-b"])
    #expect(store.inProgressSpecs.map(\.id) == ["ready-new", "ready-old"])
    #expect(store.completedSpecs.map(\.id) == ["done-a", "done-b"])
    #expect(store.visibleActiveWork.map(\.targetId) == ["live"])
    #expect(store.visibleActiveWork.first?.remainingSeconds(at: now.addingTimeInterval(40)) == 0)

    await clock.setDate(now.addingTimeInterval(31))
    await store.refresh()
    #expect(store.visibleActiveWork.isEmpty)
  }

  @Test
  func preservesTheLastValidOverviewAsStaleAcrossOfflineAndConfigurationFailures() async {
    let valid = testOverview(status: .empty)
    let cases: [(OverviewClientError, (OverviewConnectionState) -> Bool)] = [
      (.unauthorized, { if case .invalidToken = $0 { true } else { false } }),
      (.invalidToken, { if case .invalidToken = $0 { true } else { false } }),
      (.unreadableToken, { if case .invalidToken = $0 { true } else { false } }),
      (.incompatibleOverviewSchema(2), { if case .incompatible = $0 { true } else { false } }),
      (.incompatibleReceiptSchema(2), { if case .incompatible = $0 { true } else { false } }),
      (.serverStatus(503), { if case .offline = $0 { true } else { false } }),
    ]

    for (failure, matches) in cases {
      let reader = SequenceOverviewReader([.success(valid), .clientFailure(failure)])
      let store = OverviewStore(reader: reader)
      await store.refresh()
      await store.refresh()
      #expect(store.overview == valid)
      #expect(store.isStale)
      #expect(matches(store.connectionState))
    }

    let reader = SequenceOverviewReader([.success(valid), .otherFailure])
    let store = OverviewStore(reader: reader)
    await store.refresh()
    await store.refresh()
    #expect(store.overview == valid)
    #expect(store.isStale)
    if case .offline = store.connectionState {} else { Issue.record("Expected offline") }
  }

  @Test
  func treatsAMissingInstallationReceiptAsFirstRunSetup() async {
    let store = OverviewStore(
      reader: SequenceOverviewReader([.clientFailure(.unreadableReceipt)])
    )

    await store.refresh()

    if case .setupRequired(let message) = store.connectionState {
      #expect(message.contains("installation receipt"))
    } else {
      Issue.record("Expected setup-required state")
    }
    #expect(store.overview == nil)
    #expect(!store.isStale)
  }

  @Test
  func pollsImmediatelyThenAtClosedAndOpenIntervalsAndRefreshesOnOpen() async {
    let reader = SequenceOverviewReader(Array(repeating: .success(testOverview()), count: 4))
    let clock = RecordingOverviewClock(date: Date())
    let store = OverviewStore(reader: reader, clock: clock)

    store.start()
    store.start()
    #expect(await eventually { await reader.callCount == 1 })
    #expect(await eventually { await clock.sleeps == [10] })

    store.setPopoverOpen(true)
    store.setPopoverOpen(true)
    #expect(store.isPopoverOpen)
    #expect(await eventually { await reader.callCount == 2 })
    #expect(await eventually { await clock.sleeps.contains(5) })

    store.setPopoverOpen(false)
    #expect(!store.isPopoverOpen)
    #expect(await eventually { await clock.sleeps.filter { $0 == 10 }.count == 2 })

    store.stop()
    store.stop()
    let countAfterStop = await reader.callCount
    try? await Task.sleep(for: .milliseconds(10))
    #expect(await reader.callCount == countAfterStop)
  }

  @Test
  func openingBeforeStartDoesNotPollAndStartingUsesTheOpenInterval() async {
    let reader = SequenceOverviewReader([.success(testOverview())])
    let clock = RecordingOverviewClock(date: Date())
    let store = OverviewStore(reader: reader, clock: clock)

    store.setPopoverOpen(true)
    #expect(await reader.callCount == 0)
    store.start()
    #expect(await eventually { await reader.callCount == 1 })
    #expect(await eventually { await clock.sleeps == [5] })
    store.stop()
  }

  @Test
  func cancellationDoesNotTurnARefreshIntoAnOfflineFailure() async {
    let reader = SequenceOverviewReader([.suspend])
    let store = OverviewStore(reader: reader)
    store.start()
    #expect(await eventually { await reader.callCount == 1 })

    store.stop()
    try? await Task.sleep(for: .milliseconds(10))

    #expect(store.connectionState == .loading)
    #expect(store.overview == nil)
    #expect(!store.isStale)
    #expect(store.incompleteProjects.isEmpty)
    #expect(store.completedProjects.isEmpty)
    #expect(store.cancelledProjects.isEmpty)
    #expect(store.inProgressSpecs.isEmpty)
    #expect(store.completedSpecs.isEmpty)
    #expect(store.visibleActiveWork.isEmpty)
  }

  @Test
  func alreadyCancelledRefreshesDoNotPublishSuccessOrFailures() async {
    for outcome in [
      SequenceOverviewReader.Outcome.success(testOverview()),
      .clientFailure(.invalidToken),
      .otherFailure,
    ] {
      let store = OverviewStore(reader: SequenceOverviewReader([outcome]))
      let refresh = Task { await store.refresh() }
      refresh.cancel()
      await refresh.value

      #expect(store.connectionState == .loading)
      #expect(store.overview == nil)
    }
  }

  @Test
  func aCancelledPollThatReturnsNormallyDoesNotRefreshAgain() async {
    let reader = SequenceOverviewReader([.success(testOverview())])
    let clock = ControllableOverviewClock(date: Date())
    let store = OverviewStore(reader: reader, clock: clock)

    store.start()
    #expect(await eventually { await reader.callCount == 1 })
    #expect(await eventually { await clock.hasSleeper })
    store.stop()
    await clock.resumeSleep()
    try? await Task.sleep(for: .milliseconds(10))

    #expect(await reader.callCount == 1)
  }

  @Test
  func pollingRefreshesAgainAfterANormalInterval() async {
    let reader = SequenceOverviewReader([
      .success(testOverview()), .success(testOverview(status: .empty)),
    ])
    let clock = ControllableOverviewClock(date: Date())
    let store = OverviewStore(reader: reader, clock: clock)

    store.start()
    #expect(
      await eventually {
        let calls = await reader.callCount
        let sleeping = await clock.hasSleeper
        return calls == 1 && sleeping
      })
    await clock.resumeSleep()
    #expect(
      await eventually {
        let calls = await reader.callCount
        let sleeping = await clock.hasSleeper
        return calls == 2 && sleeping
      })
    #expect(store.overview?.status == .empty)
    store.stop()
    await clock.resumeSleep()
  }

  @Test
  func aStoreMayDeallocateBeforeItsPollingTaskBegins() async {
    var store: OverviewStore? = OverviewStore(reader: SequenceOverviewReader([]))
    store?.start()
    store = nil
    await Task.yield()
    #expect(store == nil)
  }
}
