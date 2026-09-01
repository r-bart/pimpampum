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
  /// Right after setup the app is relaunched from its installed copy and the daemon may still be
  /// coming up. Reporting "offline" on the first failed poll shows a red error for the five to ten
  /// seconds until the next one, immediately after a successful install. Retry quickly instead, and
  /// only declare the failure once the daemon has really had its chance.
  static let startupRetryInterval: TimeInterval = 1
  static let startupRetryLimit = 5

  @Published private(set) var overview: Overview?
  @Published private(set) var connectionState: OverviewConnectionState = .loading
  @Published private(set) var isPopoverOpen = false
  @Published private(set) var isPollingPaused = false
  @Published private(set) var currentDate: Date

  private let reader: any OverviewReading
  private let clock: any OverviewClock
  private var pollingTask: Task<Void, Never>?
  private var startupTransportFailures = 0
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
    guard !isPollingPaused else { return }
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
    guard pollingStarted, !isPollingPaused else { return }
    replacePollingTask(refreshImmediately: isOpen)
  }

  /// While the guided setup installs the daemon, a poll answers with a half-installed service and
  /// that answer used to replace the onboarding mid-apply. Polling stops for the mutation and
  /// refreshes at once when it ends.
  func setPollingPaused(_ paused: Bool) {
    guard isPollingPaused != paused else { return }
    isPollingPaused = paused
    guard pollingStarted else { return }
    if paused {
      pollingTask?.cancel()
      pollingTask = nil
    } else {
      replacePollingTask(refreshImmediately: true)
    }
  }

  func refresh() async {
    do {
      let nextOverview = try await reader.fetchOverview()
      guard !Task.isCancelled else { return }
      currentDate = await clock.now()
      overview = nextOverview
      connectionState = .online
      startupTransportFailures = 0
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
        reportTransportFailure(error.localizedDescription)
      }
    } catch {
      guard !Task.isCancelled else { return }
      currentDate = await clock.now()
      reportTransportFailure(error.localizedDescription)
    }
  }

  /// A receipt or token problem is a real answer and is reported at once. Only an unreachable
  /// daemon gets the benefit of the doubt, and only until it has been given `startupRetryLimit`
  /// chances to come up.
  private func reportTransportFailure(_ message: String) {
    guard overview == nil, startupTransportFailures < Self.startupRetryLimit else {
      connectionState = .offline(message)
      return
    }
    startupTransportFailures += 1
    connectionState = .loading
  }

  private var isWaitingForFirstOverview: Bool {
    overview == nil && connectionState == .loading
      && startupTransportFailures < Self.startupRetryLimit
  }

  private func replacePollingTask(refreshImmediately: Bool) {
    pollingTask?.cancel()
    pollingTask = Task { [weak self] in
      guard let self else { return }
      if refreshImmediately { await refresh() }
      while !Task.isCancelled {
        let interval =
          isWaitingForFirstOverview
          ? Self.startupRetryInterval
          : isPopoverOpen ? Self.openPollInterval : Self.closedPollInterval
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
