import Foundation

struct OverviewEnvelope: Codable, Equatable, Sendable {
  let meta: OverviewMetadata
  let data: Overview
}

struct OverviewMetadata: Codable, Equatable, Sendable {
  let schemaVersion: Int
}

struct Overview: Codable, Equatable, Sendable {
  let daemon: OverviewDaemon
  let generatedAt: Date
  let status: OverviewStatus
  let counts: OverviewCounts
  let projects: [OverviewProject]
  let projectsTruncated: Bool
  let activeWork: [OverviewActiveWork]
  let activeWorkTruncated: Bool
}

struct OverviewDaemon: Codable, Equatable, Sendable {
  let version: String
  let startedAt: Date
  let uptimeSeconds: Int
}

enum OverviewStatus: String, Codable, CaseIterable, Sendable {
  case active
  case available
  case complete
  case draft
  case empty
}

enum OverviewProjectStatus: String, Codable, CaseIterable, Sendable {
  case active
  case available
  case complete
  case draft

  var sortRank: Int {
    switch self {
    case .active: 0
    case .available: 1
    case .draft: 2
    case .complete: 3
    }
  }
}

enum ProjectLifecycleState: String, Codable, Sendable {
  case draft
  case ready
  case done
}

struct OverviewCounts: Codable, Equatable, Sendable {
  let workspaces: Int
  let projects: Int
  let draftProjects: Int
  let readyProjects: Int
  let completedProjects: Int
  let openTasks: Int
  let completedTasks: Int
  let activeClaims: Int
  let availableWork: Int

  var allValues: [Int] {
    [
      workspaces,
      projects,
      draftProjects,
      readyProjects,
      completedProjects,
      openTasks,
      completedTasks,
      activeClaims,
      availableWork,
    ]
  }
}

struct OverviewWorkspace: Codable, Equatable, Sendable {
  let id: String
  let name: String
  let rootPath: String
}

struct OverviewProject: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let workspace: OverviewWorkspace
  let slug: String
  let title: String
  let lifecycleState: ProjectLifecycleState
  let status: OverviewProjectStatus
  let openTaskCount: Int
  let completedTaskCount: Int
  let activeClaimCount: Int
  let availableWorkCount: Int
  let updatedAt: Date

  var allCounts: [Int] {
    [openTaskCount, completedTaskCount, activeClaimCount, availableWorkCount]
  }
}

enum OverviewTargetType: String, Codable, Sendable {
  case project
  case task
}

struct OverviewActiveWork: Codable, Equatable, Identifiable, Sendable {
  let targetType: OverviewTargetType
  let targetId: String
  let workspaceId: String
  let projectId: String
  let projectTitle: String
  let taskId: String?
  let taskTitle: String?
  let agentId: String
  let expiresAt: Date

  var id: String { "\(targetType.rawValue):\(targetId):\(agentId)" }

  var title: String { taskTitle ?? projectTitle }

  func remainingSeconds(at date: Date) -> TimeInterval {
    max(0, expiresAt.timeIntervalSince(date))
  }
}
