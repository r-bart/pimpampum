import Foundation

@testable import PimpampumMenuBar

enum TestFailure: Error, Sendable {
  case expected
}

struct StubOverviewFiles: OverviewFileReading {
  let values: [URL: Data]
  let failingURL: URL?

  init(values: [URL: Data], failingURL: URL? = nil) {
    self.values = values
    self.failingURL = failingURL
  }

  func data(at url: URL) throws -> Data {
    if url == failingURL { throw TestFailure.expected }
    guard let data = values[url] else { throw TestFailure.expected }
    return data
  }
}

actor RequestRecorder {
  private(set) var requests: [URLRequest] = []

  func record(_ request: URLRequest) {
    requests.append(request)
  }
}

struct StubOverviewTransport: OverviewTransport {
  let recorder: RequestRecorder
  let handler: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    await recorder.record(request)
    return try await handler(request)
  }
}

actor SequenceOverviewReader: OverviewReading {
  enum Outcome: Sendable {
    case success(Overview)
    case clientFailure(OverviewClientError)
    case otherFailure
    case suspend
  }

  private var outcomes: [Outcome]
  private(set) var callCount = 0

  init(_ outcomes: [Outcome]) {
    self.outcomes = outcomes
  }

  func fetchOverview() async throws -> Overview {
    callCount += 1
    let outcome = outcomes.isEmpty ? .otherFailure : outcomes.removeFirst()
    switch outcome {
    case .success(let overview):
      return overview
    case .clientFailure(let error):
      throw error
    case .otherFailure:
      throw TestFailure.expected
    case .suspend:
      try await Task.sleep(for: .seconds(3_600))
      throw CancellationError()
    }
  }
}

actor RecordingOverviewClock: OverviewClock {
  private var date: Date
  private(set) var sleeps: [TimeInterval] = []

  init(date: Date) {
    self.date = date
  }

  func now() -> Date { date }

  func setDate(_ date: Date) {
    self.date = date
  }

  func sleep(for seconds: TimeInterval) async throws {
    sleeps.append(seconds)
    try await Task.sleep(for: .seconds(3_600))
  }
}

actor ControllableOverviewClock: OverviewClock {
  private let date: Date
  private var continuation: CheckedContinuation<Void, Never>?

  init(date: Date) {
    self.date = date
  }

  var hasSleeper: Bool { continuation != nil }

  func now() -> Date { date }

  func sleep(for _: TimeInterval) async throws {
    await withCheckedContinuation { continuation = $0 }
  }

  func resumeSleep() {
    continuation?.resume()
    continuation = nil
  }
}

func fixtureData(_ name: String) throws -> Data {
  var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  for _ in 0..<4 {
    directory.deleteLastPathComponent()
  }
  return try Data(contentsOf: directory.appending(path: "test/fixtures/overview/\(name).json"))
}

func isoDate(_ value: String) -> Date {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.date(from: value)!
}

func testOverview(
  status: OverviewStatus = .active,
  projects: [OverviewProject] = [],
  specs: [OverviewSpec] = [],
  activeWork: [OverviewActiveWork] = [],
  generatedAt: Date = isoDate("2026-08-26T20:01:30.000Z")
) -> Overview {
  let counts = OverviewCounts(
    workspaces: projects.isEmpty ? 0 : 1,
    projects: projects.count,
    specs: specs.isEmpty ? projects.reduce(0) { $0 + $1.specCount } : specs.count,
    draftProjects: projects.filter { $0.lifecycleState == .draft }.count,
    openProjects: projects.filter { $0.lifecycleState == .open }.count,
    pausedProjects: projects.filter { $0.lifecycleState == .paused }.count,
    completedProjects: projects.filter { $0.lifecycleState == .done }.count,
    cancelledProjects: projects.filter { $0.lifecycleState == .cancelled }.count,
    openTasks: projects.reduce(0) { $0 + $1.openTaskCount },
    completedTasks: projects.reduce(0) { $0 + $1.completedTaskCount },
    cancelledTasks: 0,
    activeClaims: activeWork.count,
    availableWork: projects.reduce(0) { $0 + $1.availableWorkCount }
  )
  return Overview(
    daemon: OverviewDaemon(
      version: "1.0.0",
      startedAt: generatedAt.addingTimeInterval(-90),
      uptimeSeconds: 90
    ),
    generatedAt: generatedAt,
    status: status,
    counts: counts,
    projects: projects,
    projectsTruncated: false,
    specs: specs,
    specsTruncated: false,
    activeWork: activeWork,
    activeWorkTruncated: false
  )
}

func testSpec(
  id: String,
  lifecycleState: SpecLifecycleState,
  projectLifecycleState: ProjectLifecycleState = .open,
  updatedAt: Date,
  taskCount: Int = 4,
  completedTaskCount: Int = 1,
  activeClaimCount: Int = 0
) -> OverviewSpec {
  OverviewSpec(
    id: id,
    projectId: "project-\(id)",
    projectTitle: "Project \(id)",
    projectLifecycleState: projectLifecycleState,
    workspace: OverviewWorkspace(id: "workspace", name: "Workspace", rootPath: "/tmp/workspace"),
    slug: id,
    title: "Spec \(id)",
    lifecycleState: lifecycleState,
    taskCount: taskCount,
    openTaskCount: max(0, taskCount - completedTaskCount),
    completedTaskCount: completedTaskCount,
    activeClaimCount: activeClaimCount,
    updatedAt: updatedAt
  )
}

func testProject(
  id: String,
  status: OverviewProjectStatus,
  updatedAt: Date,
  lifecycleState: ProjectLifecycleState? = nil
) -> OverviewProject {
  let defaultLifecycle: ProjectLifecycleState = switch status {
  case .active, .available: .open
  case .draft: .draft
  case .paused: .paused
  case .complete: .done
  }
  return OverviewProject(
    id: id,
    workspace: OverviewWorkspace(id: "workspace", name: "Workspace", rootPath: "/tmp/workspace"),
    slug: id,
    title: id,
    lifecycleState: lifecycleState ?? defaultLifecycle,
    status: status,
    specCount: 1,
    openTaskCount: status == .available || status == .active ? 1 : 0,
    completedTaskCount: status == .complete ? 1 : 0,
    activeClaimCount: status == .active ? 1 : 0,
    availableWorkCount: status == .available || status == .active ? 1 : 0,
    updatedAt: updatedAt
  )
}

func eventually(_ condition: @escaping @Sendable () async -> Bool) async -> Bool {
  for _ in 0..<200 {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(2))
  }
  return false
}
