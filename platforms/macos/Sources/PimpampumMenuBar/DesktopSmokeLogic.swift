import CryptoKit
import Foundation

struct SmokeHarnessRequest: Equatable {
  let jsonURL: URL
  let pngURL: URL
  let seedURL: URL?
  let refreshAfterSeed: Bool
  let projectId: String?
  let controlLabel: String?
}

struct SmokeProjectRow: Codable, Equatable {
  let id: String
  let title: String
  let workspacePath: String
  let status: String
}

struct DesktopSmokeSnapshot: Codable, Equatable {
  let schemaVersion: Int
  let visualState: String
  let accessibilityLabel: String
  let accessibilityLabels: [String]
  let activeCount: Int
  let connectionState: String
  let stale: Bool
  let markResource: String
  let markResourceSha256: String
  let markIsTemplate: Bool
  let statusBadgeSystemImage: String
  let displayedActiveCount: String?
  let projectRows: [SmokeProjectRow]
  let completedCollapsed: Bool
  let renderedPngSha256: String
  let activatedControlLabel: String?
  let openedWorkspacePath: String?
  let settingsWindowReused: Bool?
  let settingsWindowCount: Int?
  let settingsWindowWidth: Int?
  let settingsWindowHeight: Int?
  let settingsWindowFocused: Bool?
  let settingsBackupState: String?
  let settingsConfiguredPath: String?
  let settingsErrorPresent: Bool?
  let quitActionInvoked: Bool
}

enum DesktopSmokeLogic {
  static func request(from arguments: [String]) throws -> SmokeHarnessRequest? {
    guard arguments.first == "--ui-smoke-snapshot" else { return nil }
    guard arguments.count >= 3 else { throw DesktopSmokeError.missingOutputPaths }

    return SmokeHarnessRequest(
      jsonURL: URL(fileURLWithPath: arguments[1]),
      pngURL: URL(fileURLWithPath: arguments[2]),
      seedURL: option("--seed-overview", in: arguments).map(URL.init(fileURLWithPath:)),
      refreshAfterSeed: !arguments.contains("--retain-seed"),
      projectId: option("--open-project", in: arguments),
      controlLabel: option("--activate-control", in: arguments)
    )
  }

  static func decodeOverview(_ data: Data) throws -> Overview {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let value = try container.decode(String.self)
      let fractional = ISO8601DateFormatter()
      fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = fractional.date(from: value) { return date }
      let standard = ISO8601DateFormatter()
      standard.formatOptions = [.withInternetDateTime]
      if let date = standard.date(from: value) { return date }
      throw DesktopSmokeError.invalidSeed
    }
    return try decoder.decode(Overview.self, from: data)
  }

  static func project(withId id: String, in overview: Overview?) throws -> OverviewProject {
    guard let project = overview?.projects.first(where: { $0.id == id }) else {
      throw DesktopSmokeError.projectMissing(id)
    }
    return project
  }

  static func connectionLabel(_ state: OverviewConnectionState) -> String {
    switch state {
    case .loading: "loading"
    case .online: "online"
    case .offline: "offline"
    case .invalidToken: "credentials"
    case .incompatible: "incompatible"
    }
  }

  static func snapshot(
    overview: Overview?,
    visualState: StatusVisualState,
    activeCount: Int,
    connectionState: OverviewConnectionState,
    stale: Bool,
    png: Data,
    markResourceSha256: String,
    markIsTemplate: Bool,
    accessibilityLabels: [String],
    activatedControlLabel: String?,
    openedWorkspacePath: String?,
    settingsWindowReused: Bool?,
    settingsWindowCount: Int?,
    settingsWindowWidth: Int?,
    settingsWindowHeight: Int?,
    settingsWindowFocused: Bool?,
    settingsBackupState: String?,
    settingsConfiguredPath: String?,
    settingsErrorPresent: Bool?,
    quitActionInvoked: Bool
  ) -> DesktopSmokeSnapshot {
    let rows = (overview?.projects ?? []).map { project in
      SmokeProjectRow(
        id: project.id,
        title: project.title,
        workspacePath: project.workspace.rootPath,
        status: project.status.rawValue
      )
    }
    return DesktopSmokeSnapshot(
      schemaVersion: 2,
      visualState: visualState.label,
      accessibilityLabel: StatusIndicatorPresentation.accessibilityLabel(
        state: visualState,
        activeCount: activeCount
      ),
      accessibilityLabels: accessibilityLabels.sorted(),
      activeCount: activeCount,
      connectionState: connectionLabel(connectionState),
      stale: stale,
      markResource: "PimpampumCompact.pdf",
      markResourceSha256: markResourceSha256,
      markIsTemplate: markIsTemplate,
      statusBadgeSystemImage: visualState.badgeKind.systemImageName,
      displayedActiveCount: StatusIndicatorPresentation.displayCount(activeCount),
      projectRows: rows,
      completedCollapsed: true,
      renderedPngSha256: SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined(),
      activatedControlLabel: activatedControlLabel,
      openedWorkspacePath: openedWorkspacePath,
      settingsWindowReused: settingsWindowReused,
      settingsWindowCount: settingsWindowCount,
      settingsWindowWidth: settingsWindowWidth,
      settingsWindowHeight: settingsWindowHeight,
      settingsWindowFocused: settingsWindowFocused,
      settingsBackupState: settingsBackupState,
      settingsConfiguredPath: settingsConfiguredPath,
      settingsErrorPresent: settingsErrorPresent,
      quitActionInvoked: quitActionInvoked
    )
  }

  private static func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
      return nil
    }
    return arguments[index + 1]
  }
}

enum DesktopSmokeError: LocalizedError, Equatable {
  case missingOutputPaths
  case invalidSeed
  case projectMissing(String)
  case renderedControlMissing(String)
  case renderedControlActivationFailed(String)
  case popoverDismissalFailed
  case markResourceMissing
  case renderFailed

  var errorDescription: String? {
    switch self {
    case .missingOutputPaths: "Missing UI smoke output paths."
    case .invalidSeed: "The seeded overview is invalid."
    case .projectMissing(let id): "The project row is missing: \(id)"
    case .renderedControlMissing(let label): "The rendered control is missing: \(label)"
    case .renderedControlActivationFailed(let label):
      "The rendered control could not be activated: \(label)"
    case .popoverDismissalFailed: "The native popover remained visible after opening Settings."
    case .markResourceMissing: "PimpampumCompact.pdf is missing or invalid."
    case .renderFailed: "The native popover could not be rendered."
    }
  }
}
