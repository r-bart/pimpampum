import SwiftUI

enum StatusBadgeKind: Equatable {
  case loadingRing
  case activeDot
  case availableDiamond
  case draftRing
  case completionCheck
  case emptyRing
  case disconnected
  case alert

  var systemImageName: String {
    switch self {
    case .loadingRing: "clock"
    case .activeDot: "circle.fill"
    case .availableDiamond: "diamond.fill"
    case .draftRing: "circle.dashed"
    case .completionCheck: "checkmark.circle.fill"
    case .emptyRing: "circle"
    case .disconnected: "minus.circle.fill"
    case .alert: "exclamationmark.triangle.fill"
    }
  }
}

enum StatusVisualState: Equatable {
  case loading
  case active
  case available
  case draft
  case complete
  case empty
  case stale
  case offline
  case authenticationError
  case incompatible

  var label: String {
    switch self {
    case .loading: "Loading"
    case .active: "Active"
    case .available: "Work available"
    case .draft: "Drafts only"
    case .complete: "All complete"
    case .empty: "No projects"
    case .stale: "Offline — stale data"
    case .offline: "Offline"
    case .authenticationError: "Authentication error"
    case .incompatible: "Incompatible version"
    }
  }

  var badgeKind: StatusBadgeKind {
    switch self {
    case .loading: .loadingRing
    case .active: .activeDot
    case .available: .availableDiamond
    case .draft: .draftRing
    case .complete: .completionCheck
    case .empty: .emptyRing
    case .stale, .offline: .disconnected
    case .authenticationError, .incompatible: .alert
    }
  }

  var color: Color {
    switch self {
    case .active: .blue
    case .available: .orange
    case .complete: .green
    case .stale, .offline, .authenticationError, .incompatible: .red
    case .loading, .draft, .empty: .secondary
    }
  }
}

enum StatusIndicatorPresentation {
  static func displayCount(_ activeCount: Int) -> String? {
    guard activeCount > 0 else { return nil }
    return activeCount >= 100 ? "99+" : String(activeCount)
  }

  static func accessibilityLabel(state: StatusVisualState, activeCount: Int) -> String {
    let boundedCount = max(0, activeCount)
    let claims =
      boundedCount == 1 ? "1 active claim" : "\(boundedCount) active claims"
    return "Pimpampum: \(state.label), \(claims)"
  }
}

extension StatusPopover {
  static let containerWidth: CGFloat = 360
  static let bodyMaximumHeight: CGFloat = 480
  static let contentTitleLineLimit = 2
  static let metadataLineLimit = 1

  static func visualState(
    connectionState: OverviewConnectionState,
    overview: Overview?
  ) -> StatusVisualState {
    switch connectionState {
    case .loading:
      return overview == nil ? .loading : .stale
    case .online:
      guard let overview else { return .loading }
      return visualState(for: overview.status)
    case .offline:
      return overview == nil ? .offline : .stale
    case .invalidToken:
      return .authenticationError
    case .incompatible:
      return .incompatible
    }
  }

  static func shouldShowOverview(
    connectionState: OverviewConnectionState,
    overview: Overview?
  ) -> Bool {
    guard overview != nil else { return false }
    switch connectionState {
    case .loading, .online, .offline:
      return true
    case .invalidToken, .incompatible:
      return false
    }
  }

  static func visibleActiveCount(
    connectionState: OverviewConnectionState,
    overview: Overview?
  ) -> Int {
    guard shouldShowOverview(connectionState: connectionState, overview: overview),
      let overview
    else { return 0 }
    return overview.counts.activeClaims
  }

  static func leaseRemainingText(_ seconds: TimeInterval) -> String {
    let remaining = max(0, Int(seconds.rounded(.down)))
    if remaining == 0 { return "Expired" }
    if remaining < 60 { return "<1m remaining" }
    let hours = remaining / 3_600
    let minutes = (remaining % 3_600) / 60
    if hours == 0 { return "\(minutes)m remaining" }
    if minutes == 0 { return "\(hours)h remaining" }
    return "\(hours)h \(minutes)m remaining"
  }

  static func summaryText(_ counts: OverviewCounts) -> String {
    "\(counts.projects) projects · \(counts.activeClaims) active · \(counts.availableWork) available"
  }

  static func projectCountsText(_ project: OverviewProject) -> String {
    switch project.status {
    case .active:
      if project.availableWorkCount > 0 {
        return "\(project.activeClaimCount) active · \(project.availableWorkCount) available"
      }
      return "\(project.activeClaimCount) active"
    case .available:
      return "\(project.availableWorkCount) available"
    case .draft:
      return "Draft"
    case .complete:
      return "Complete · \(project.completedTaskCount) completed tasks"
    }
  }

  static func projectAccessibilityValue(_ project: OverviewProject) -> String {
    "\(project.status.rawValue), \(projectCountsText(project))"
  }

  static func projectMetadataText(_ project: OverviewProject) -> String {
    "\(project.workspace.name) · \(project.slug)"
  }

  static func projectOpenAccessibilityLabel(_ project: OverviewProject) -> String {
    "Open \(project.title) in Finder"
  }

  static func projectOpenAccessibilityHint(_ project: OverviewProject) -> String {
    "Opens workspace \(project.workspace.name)"
  }

  static func workspaceRevealError(_ project: OverviewProject, description: String) -> String {
    "\(project.title): \(description)"
  }

  static func projectSymbol(_ status: OverviewProjectStatus) -> String {
    switch status {
    case .active: "bolt.circle.fill"
    case .available: "circle.fill"
    case .draft: "circle.dashed"
    case .complete: "checkmark.circle.fill"
    }
  }

  static func projectColor(_ status: OverviewProjectStatus) -> Color {
    switch status {
    case .active: .blue
    case .available: .orange
    case .draft: .secondary
    case .complete: .green
    }
  }

  private static func visualState(for status: OverviewStatus) -> StatusVisualState {
    switch status {
    case .active: .active
    case .available: .available
    case .complete: .complete
    case .draft: .draft
    case .empty: .empty
    }
  }
}
