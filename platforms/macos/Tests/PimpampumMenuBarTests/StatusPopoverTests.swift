import AppKit
import Foundation
import SwiftUI
import Testing

@testable import PimpampumMenuBar

@Suite
@MainActor
struct StatusPopoverTests {
  @Test
  func everyVisualStateHasCompletePresentationMetadata() {
    #expect(PimpampumBrand.displayName == "pim • pam • pum")
    #expect(PimpampumBrand.settingsTitle == "pim • pam • pum Settings")
    #expect(PimpampumBrand.quitTitle == "Quit")

    let states: [StatusVisualState] = [
      .loading,
      .active,
      .available,
      .draft,
      .paused,
      .complete,
      .cancelled,
      .empty,
      .setupRequired,
      .stale,
      .offline,
      .authenticationError,
      .incompatible,
    ]

    for state in states {
      #expect(!state.label.isEmpty)
      #expect(!state.badgeKind.systemImageName.isEmpty)
      _ = state.color
    }
  }

  @Test
  func mapsEveryServerSemanticStateToTheFixedIndicatorPresentation() {
    let expected: [(OverviewStatus, StatusVisualState)] = [
      (.active, .active),
      (.available, .available),
      (.draft, .draft),
      (.paused, .paused),
      (.complete, .complete),
      (.empty, .empty),
    ]

    for (status, visualState) in expected {
      let overview = makeOverview(status: status)
      #expect(
        StatusPopover.visualState(connectionState: .online, overview: overview)
          == visualState
      )
      #expect(!visualState.label.isEmpty)
      #expect(!visualState.badgeKind.systemImageName.isEmpty)
    }

    let cancelled = makeOverview(status: .complete, cancelledProjects: 1)
    #expect(
      StatusPopover.visualState(connectionState: .online, overview: cancelled)
        == .cancelled
    )
  }

  @Test
  func distinguishesLoadingOfflineStaleAuthenticationAndIncompatibleStates() {
    let overview = makeOverview(status: .active)

    #expect(StatusPopover.visualState(connectionState: .loading, overview: nil) == .loading)
    #expect(StatusPopover.visualState(connectionState: .online, overview: nil) == .loading)
    #expect(
      StatusPopover.visualState(connectionState: .setupRequired("missing"), overview: nil)
        == .setupRequired
    )
    #expect(StatusPopover.visualState(connectionState: .loading, overview: overview) == .stale)
    #expect(
      StatusPopover.visualState(connectionState: .offline("offline"), overview: nil)
        == .offline
    )
    #expect(
      StatusPopover.visualState(connectionState: .offline("offline"), overview: overview)
        == .stale
    )
    #expect(
      StatusPopover.visualState(connectionState: .invalidToken("denied"), overview: overview)
        == .authenticationError
    )
    #expect(
      StatusPopover.visualState(connectionState: .incompatible("schema"), overview: overview)
        == .incompatible
    )
  }

  @Test
  func showsOnlyCompatibleOrExplicitlyStaleOverviewData() {
    let overview = makeOverview(status: .active)

    #expect(StatusPopover.shouldShowOverview(connectionState: .online, overview: overview))
    #expect(StatusPopover.shouldShowOverview(connectionState: .loading, overview: overview))
    #expect(
      StatusPopover.shouldShowOverview(connectionState: .offline("offline"), overview: overview))
    #expect(!StatusPopover.shouldShowOverview(connectionState: .online, overview: nil))
    #expect(
      !StatusPopover.shouldShowOverview(
        connectionState: .setupRequired("missing"),
        overview: overview
      )
    )
    #expect(
      !StatusPopover.shouldShowOverview(
        connectionState: .invalidToken("denied"),
        overview: overview
      )
    )
    #expect(
      !StatusPopover.shouldShowOverview(
        connectionState: .incompatible("schema"),
        overview: overview
      )
    )
    #expect(
      StatusPopover.visibleActiveCount(connectionState: .online, overview: overview) == 1
    )
    #expect(StatusPopover.visibleActiveCount(connectionState: .online, overview: nil) == 0)
    #expect(
      StatusPopover.visibleActiveCount(
        connectionState: .offline("offline"),
        overview: overview
      ) == 1
    )
    #expect(
      StatusPopover.visibleActiveCount(
        connectionState: .incompatible("schema"),
        overview: overview
      ) == 0
    )
  }

  @Test(arguments: [
    (TimeInterval(-1), "Expired"),
    (TimeInterval(0), "Expired"),
    (TimeInterval(1), "<1m remaining"),
    (TimeInterval(59), "<1m remaining"),
    (TimeInterval(60), "1m remaining"),
    (TimeInterval(3_599), "59m remaining"),
    (TimeInterval(3_600), "1h remaining"),
    (TimeInterval(3_720), "1h 2m remaining"),
  ])
  func formatsLeaseBounds(seconds: TimeInterval, expected: String) {
    #expect(StatusPopover.leaseRemainingText(seconds) == expected)
  }

  @Test
  func preservesBothActiveAndAvailableCountsAndDisambiguatesProjects() {
    let project = makeProject(
      status: .active,
      activeClaimCount: 2,
      availableWorkCount: 3
    )

    #expect(StatusPopover.projectCountsText(project) == "2 active · 3 available")
    #expect(StatusPopover.projectAccessibilityValue(project) == "active, 2 active · 3 available")
    #expect(StatusPopover.projectMetadataText(project) == "100 Projects · project-slug")
    #expect(StatusPopover.projectOpenAccessibilityLabel(project) == "Open Project in Finder")
    #expect(StatusPopover.projectOpenAccessibilityHint(project) == "Opens workspace 100 Projects")
    #expect(
      StatusPopover.workspaceRevealError(project, description: "Folder missing")
        == "Project: Folder missing")
  }

  @Test
  func formatsEveryProjectStatusWithoutRelyingOnDecorativeIcons() {
    let cases: [(OverviewProjectStatus, Int, String)] = [
      (.active, 0, "2 active"),
      (.available, 3, "3 available"),
      (.draft, 0, "Draft"),
      (.paused, 0, "Paused"),
      (.complete, 0, "Complete · 2 completed tasks"),
    ]

    for (status, available, expected) in cases {
      let project = makeProject(
        status: status,
        activeClaimCount: 2,
        availableWorkCount: available
      )
      #expect(StatusPopover.projectCountsText(project) == expected)
    }

    let complete = makeProject(status: .complete, activeClaimCount: 0, availableWorkCount: 0)
    let cancelled = makeProject(
      status: .complete,
      activeClaimCount: 0,
      availableWorkCount: 0,
      lifecycleState: .cancelled
    )
    #expect(StatusPopover.projectCountsText(cancelled) == "Cancelled")
    #expect(StatusPopover.projectAccessibilityValue(cancelled) == "cancelled, Cancelled")
    #expect(StatusPopover.projectCountsText(complete) == "Complete · 2 completed tasks")
  }

  @Test
  func formatsBoundedSummary() {
    let counts = makeOverview(status: .active).counts

    #expect(StatusPopover.summaryText(counts) == "4 projects · 1 active · 2 available")
  }

  @Test
  func formatsNamedSpecProgressAndWorkspaceAccessibility() {
    let spec = testSpec(
      id: "widget-v1",
      lifecycleState: .ready,
      updatedAt: Date(timeIntervalSince1970: 100),
      taskCount: 5,
      completedTaskCount: 2,
      activeClaimCount: 2
    )

    #expect(StatusPopover.specProgressText(spec) == "2/5 tasks · 2 active")
    #expect(StatusPopover.specMetadataText(spec) == "Project widget-v1 · 2/5 tasks · 2 active")
    #expect(StatusPopover.specOpenAccessibilityLabel(spec) == "Open Spec widget-v1 in Finder")
    #expect(
      StatusPopover.specOpenAccessibilityHint(spec)
        == "Opens project Project widget-v1 in workspace Workspace"
    )
    #expect(
      StatusPopover.specAccessibilityValue(spec)
        == "ready, Project widget-v1 · 2/5 tasks · 2 active"
    )
    #expect(
      StatusPopover.workspaceRevealError(spec, description: "Folder missing")
        == "Spec widget-v1: Folder missing"
    )

    let singular = testSpec(
      id: "single",
      lifecycleState: .done,
      updatedAt: Date(timeIntervalSince1970: 100),
      taskCount: 1,
      completedTaskCount: 1
    )
    #expect(StatusPopover.specProgressText(singular) == "1/1 task")
  }

  @Test
  func longExpandedSpecAndProjectListsRemainScrollableInsideTheApprovedBounds() async {
    let now = Date(timeIntervalSince1970: 120)
    let specs = (0..<20).map { index in
      testSpec(
        id: "spec-\(index)", lifecycleState: .ready,
        updatedAt: now.addingTimeInterval(TimeInterval(-index))
      )
    }
    let projects = (0..<20).map { index in
      testProject(
        id: "project-\(index)", status: .available,
        updatedAt: now.addingTimeInterval(TimeInterval(-index))
      )
    }
    let store = OverviewStore(
      reader: StaticOverviewReader(
        overview: testOverview(projects: projects, specs: specs, generatedAt: now)
      )
    )
    await store.refresh()
    let view = NSHostingView(rootView: StatusPopover(store: store))

    view.layoutSubtreeIfNeeded()

    #expect(view.fittingSize.width == StatusPopover.containerWidth)
    #expect(view.fittingSize.height > StatusPopover.bodyMaximumHeight)
    #expect(view.fittingSize.height < StatusPopover.bodyMaximumHeight + 160)
  }

  @Test
  func viewBoundaryAcceptsOnlyAReadStoreAndWorkspaceOpener() {
    let store = OverviewStore(reader: StaticOverviewReader(overview: makeOverview(status: .empty)))
    let opener = WorkspaceOpener(
      validateDirectory: { _ in true },
      openDirectory: { _ in true }
    )

    _ = StatusIndicator(state: .empty, activeCount: 0)
    _ = StatusPopover(store: store, workspaceOpener: opener)
  }

  @Test
  func preservesTheApprovedFixedPopoverGeometryAndContentBounds() {
    #expect(StatusPopover.containerWidth == 360)
    #expect(StatusPopover.bodyMaximumHeight == 480)
    #expect(StatusPopover.contentTitleLineLimit == 2)
    #expect(StatusPopover.metadataLineLimit == 1)
    #expect(PimpampumBrand.versionText() == "Version 1.2.4")
  }

  @Test
  func setupAssistantKeepsLoginRegistrationAsASeparateSystemAction() {
    var events: [String] = []
    let assistant = SetupAssistant(
      registerLoginItem: { events.append("register") }
    )

    assistant.prepareApp()
    #expect(events == ["register"])
    #expect(SetupOnboardingCopy.title == "One private home for agent context")
    _ = SetupOnboardingView(assistant: assistant, onCheckAgain: {})
  }

  @Test
  func emptyOverviewKeepsTheScrollableBodyVisibleAtItsIntrinsicHeight() async {
    let store = OverviewStore(reader: StaticOverviewReader(overview: makeOverview(status: .empty)))
    await store.refresh()
    let view = NSHostingView(rootView: StatusPopover(store: store))

    view.layoutSubtreeIfNeeded()

    #expect(view.fittingSize.height > 200)
  }

  @Test
  func setupRequiredRendersTheCompleteQuietOnboardingAtTheFixedWidth() async {
    let store = OverviewStore(
      reader: SequenceOverviewReader([.clientFailure(.unreadableReceipt)])
    )
    await store.refresh()
    let view = NSHostingView(rootView: StatusPopover(store: store))

    view.layoutSubtreeIfNeeded()

    #expect(view.fittingSize.width == StatusPopover.containerWidth)
    #expect(view.fittingSize.height > 350)
  }
}

private struct StaticOverviewReader: OverviewReading {
  let overview: Overview

  func fetchOverview() async throws -> Overview { overview }
}

private func makeOverview(status: OverviewStatus, cancelledProjects: Int = 0) -> Overview {
  Overview(
    daemon: OverviewDaemon(
      version: "1.0.0",
      startedAt: Date(timeIntervalSince1970: 0),
      uptimeSeconds: 120
    ),
    generatedAt: Date(timeIntervalSince1970: 120),
    status: status,
    counts: OverviewCounts(
      workspaces: 1,
      projects: 4,
      specs: 5,
      draftProjects: 1,
      openProjects: 2,
      pausedProjects: 0,
      completedProjects: 1,
      cancelledProjects: cancelledProjects,
      openTasks: 2,
      completedTasks: 1,
      cancelledTasks: 0,
      activeClaims: 1,
      availableWork: 2
    ),
    projects: [],
    projectsTruncated: false,
    specs: [],
    specsTruncated: false,
    activeWork: [],
    activeWorkTruncated: false
  )
}

private func makeProject(
  status: OverviewProjectStatus,
  activeClaimCount: Int,
  availableWorkCount: Int,
  lifecycleState: ProjectLifecycleState? = nil
) -> OverviewProject {
  let defaultLifecycle: ProjectLifecycleState =
    switch status {
    case .active, .available: .open
    case .draft: .draft
    case .paused: .paused
    case .complete: .done
    }
  return OverviewProject(
    id: "project",
    workspace: OverviewWorkspace(
      id: "workspace",
      name: "100 Projects",
      rootPath: "/Users/example/100 Projects"
    ),
    slug: "project-slug",
    title: "Project",
    lifecycleState: lifecycleState ?? defaultLifecycle,
    status: status,
    specCount: 1,
    openTaskCount: 1,
    completedTaskCount: 2,
    activeClaimCount: activeClaimCount,
    availableWorkCount: availableWorkCount,
    updatedAt: Date(timeIntervalSince1970: 100)
  )
}
