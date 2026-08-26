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
    let states: [StatusVisualState] = [
      .loading,
      .active,
      .available,
      .draft,
      .complete,
      .empty,
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
  }

  @Test
  func distinguishesLoadingOfflineStaleAuthenticationAndIncompatibleStates() {
    let overview = makeOverview(status: .active)

    #expect(StatusPopover.visualState(connectionState: .loading, overview: nil) == .loading)
    #expect(StatusPopover.visualState(connectionState: .online, overview: nil) == .loading)
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
    #expect(StatusPopover.projectSymbol(.active) != StatusPopover.projectSymbol(.available))
    #expect(StatusPopover.projectSymbol(.draft) != StatusPopover.projectSymbol(.complete))
  }

  @Test
  func formatsAndColorsEveryProjectStatus() {
    let cases: [(OverviewProjectStatus, Int, String)] = [
      (.active, 0, "2 active"),
      (.available, 3, "3 available"),
      (.draft, 0, "Draft"),
      (.complete, 0, "Complete · 2 completed tasks"),
    ]

    for (status, available, expected) in cases {
      let project = makeProject(
        status: status,
        activeClaimCount: 2,
        availableWorkCount: available
      )
      #expect(StatusPopover.projectCountsText(project) == expected)
      _ = StatusPopover.projectColor(status)
    }
  }

  @Test
  func formatsBoundedSummary() {
    let counts = makeOverview(status: .active).counts

    #expect(StatusPopover.summaryText(counts) == "4 projects · 1 active · 2 available")
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
  }

  @Test
  func emptyOverviewKeepsTheScrollableBodyVisibleAtItsIntrinsicHeight() async {
    let store = OverviewStore(reader: StaticOverviewReader(overview: makeOverview(status: .empty)))
    await store.refresh()
    let view = NSHostingView(rootView: StatusPopover(store: store))

    view.layoutSubtreeIfNeeded()

    #expect(view.fittingSize.height > 200)
  }
}

private struct StaticOverviewReader: OverviewReading {
  let overview: Overview

  func fetchOverview() async throws -> Overview { overview }
}

private func makeOverview(status: OverviewStatus) -> Overview {
  Overview(
    daemon: OverviewDaemon(
      version: "0.1.0",
      startedAt: Date(timeIntervalSince1970: 0),
      uptimeSeconds: 120
    ),
    generatedAt: Date(timeIntervalSince1970: 120),
    status: status,
    counts: OverviewCounts(
      workspaces: 1,
      projects: 4,
      draftProjects: 1,
      readyProjects: 2,
      completedProjects: 1,
      openTasks: 2,
      completedTasks: 1,
      activeClaims: 1,
      availableWork: 2
    ),
    projects: [],
    projectsTruncated: false,
    activeWork: [],
    activeWorkTruncated: false
  )
}

private func makeProject(
  status: OverviewProjectStatus,
  activeClaimCount: Int,
  availableWorkCount: Int
) -> OverviewProject {
  OverviewProject(
    id: "project",
    workspace: OverviewWorkspace(
      id: "workspace",
      name: "100 Projects",
      rootPath: "/Users/example/100 Projects"
    ),
    slug: "project-slug",
    title: "Project",
    lifecycleState: status == .complete ? .done : .ready,
    status: status,
    openTaskCount: 1,
    completedTaskCount: 2,
    activeClaimCount: activeClaimCount,
    availableWorkCount: availableWorkCount,
    updatedAt: Date(timeIntervalSince1970: 100)
  )
}
