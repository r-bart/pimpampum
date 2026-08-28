import Combine
import Foundation

protocol OverviewClock: Sendable {
  func now() async -> Date
  func sleep(for seconds: TimeInterval) async throws
}

enum OverviewConnectionState: Equatable, Sendable {
  case loading
  case online
  case setupRequired(String)
  case offline(String)
  case invalidToken(String)
  case incompatible(String)
}

@MainActor
final class OverviewStore: ObservableObject {
  static let closedPollInterval: TimeInterval = 10
  static let openPollInterval: TimeInterval = 5

  @Published private(set) var overview: Overview?
  @Published private(set) var connectionState: OverviewConnectionState = .loading
  @Published private(set) var isPopoverOpen = false
  @Published private(set) var currentDate: Date

  private let reader: any OverviewReading
  private let clock: any OverviewClock
  private var pollingTask: Task<Void, Never>?
  private var pollingStarted = false

  init(reader: any OverviewReading, clock: any OverviewClock = SystemOverviewClock()) {
    self.reader = reader
    self.clock = clock
    currentDate = .distantPast
  }

  var isStale: Bool {
    overview != nil && connectionState != .online
  }

  var incompleteProjects: [OverviewProject] {
    (overview?.projects ?? [])
      .filter { $0.lifecycleState != .done && $0.lifecycleState != .cancelled }
      .sorted(by: Self.projectComesFirst)
  }

  var completedProjects: [OverviewProject] {
    (overview?.projects ?? [])
      .filter { $0.lifecycleState == .done }
      .sorted(by: Self.projectComesFirst)
  }

  var cancelledProjects: [OverviewProject] {
    (overview?.projects ?? [])
      .filter { $0.lifecycleState == .cancelled }
      .sorted(by: Self.projectComesFirst)
  }

  var inProgressSpecs: [OverviewSpec] {
    (overview?.specs ?? [])
      .filter { $0.lifecycleState == .ready && $0.projectLifecycleState == .open }
      .sorted(by: Self.specComesFirst)
  }

  var completedSpecs: [OverviewSpec] {
    (overview?.specs ?? [])
      .filter { $0.lifecycleState == .done }
      .sorted(by: Self.specComesFirst)
  }

  var visibleActiveWork: [OverviewActiveWork] {
    (overview?.activeWork ?? []).filter { $0.expiresAt > currentDate }
  }

  func start() {
    guard !pollingStarted else { return }
    pollingStarted = true
    replacePollingTask(refreshImmediately: true)
  }

  func stop() {
    pollingStarted = false
    pollingTask?.cancel()
    pollingTask = nil
  }

  func setPopoverOpen(_ isOpen: Bool) {
    guard isPopoverOpen != isOpen else { return }
    isPopoverOpen = isOpen
    guard pollingStarted else { return }
    replacePollingTask(refreshImmediately: isOpen)
  }

  func refresh() async {
    do {
      let nextOverview = try await reader.fetchOverview()
      guard !Task.isCancelled else { return }
      currentDate = await clock.now()
      overview = nextOverview
      connectionState = .online
    } catch is CancellationError {
      return
    } catch let error as OverviewClientError {
      guard !Task.isCancelled else { return }
      currentDate = await clock.now()
      switch error {
      case .unreadableReceipt:
        connectionState = .setupRequired(error.localizedDescription)
      case .invalidToken, .unauthorized, .unreadableToken:
        connectionState = .invalidToken(error.localizedDescription)
      case .incompatibleOverviewSchema, .incompatibleReceiptSchema:
        connectionState = .incompatible(error.localizedDescription)
      default:
        connectionState = .offline(error.localizedDescription)
      }
    } catch {
      guard !Task.isCancelled else { return }
      currentDate = await clock.now()
      connectionState = .offline(error.localizedDescription)
    }
  }

  private func replacePollingTask(refreshImmediately: Bool) {
    pollingTask?.cancel()
    pollingTask = Task { [weak self] in
      guard let self else { return }
      if refreshImmediately { await refresh() }
      while !Task.isCancelled {
        let interval = isPopoverOpen ? Self.openPollInterval : Self.closedPollInterval
        do {
          try await clock.sleep(for: interval)
        } catch {
          return
        }
        guard !Task.isCancelled else { return }
        await refresh()
      }
    }
  }

  private static func projectComesFirst(_ lhs: OverviewProject, _ rhs: OverviewProject) -> Bool {
    if lhs.status.sortRank != rhs.status.sortRank {
      return lhs.status.sortRank < rhs.status.sortRank
    }
    if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
    return lhs.id < rhs.id
  }

  private static func specComesFirst(_ lhs: OverviewSpec, _ rhs: OverviewSpec) -> Bool {
    if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
    return lhs.id < rhs.id
  }
}
