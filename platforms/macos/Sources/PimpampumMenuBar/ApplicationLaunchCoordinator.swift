import Foundation

/// What a launching instance needs to know about the copies already running, so the decision can
/// be tested without an NSRunningApplication.
protocol RunningInstance {
  var processIdentifier: pid_t { get }
  var launchDate: Date? { get }
  var bundleURL: URL? { get }
  var isTerminated: Bool { get }
}

enum SingleInstancePolicy {
  /// Passed by the copy that relaunches the installed app, so the newcomer knows which process
  /// promised to exit and waits for it instead of judging it as a peer.
  static let relaunchedFromOption = "--relaunched-from"
  static let predecessorExitTimeout: TimeInterval = 5
  static let predecessorPollInterval: TimeInterval = 0.1
  static var predecessorPollLimit: Int {
    Int((predecessorExitTimeout / predecessorPollInterval).rounded())
  }

  static func relaunchArguments(from processIdentifier: pid_t) -> [String] {
    [relaunchedFromOption, String(processIdentifier)]
  }

  /// The process that launched this one. Anything but a well-formed positive pid is ignored, since
  /// waiting on a bad value would only delay the launch.
  static func predecessor(in arguments: [String]) -> pid_t? {
    guard let index = arguments.firstIndex(of: relaunchedFromOption),
      index + 1 < arguments.count,
      let value = Int32(arguments[index + 1]),
      value > 0
    else { return nil }
    return value
  }

  /// True when an older copy of this very bundle is already running. A copy running from another
  /// path is a different installation, not a duplicate: the Downloads copy that relaunches the
  /// installed one, or an older adopted version beside a newer build, must never make the newcomer
  /// exit. Ties, unknown launch dates and peers that already ended keep the newcomer alive rather
  /// than risk leaving the menu bar with no app at all.
  static func shouldStandDown(
    current: any RunningInstance,
    bundleURL: URL,
    peers: [any RunningInstance]
  ) -> Bool {
    guard let launchedAt = current.launchDate else { return false }
    let bundle = bundleURL.canonicalBundleURL
    return peers.contains { peer in
      guard peer.processIdentifier != current.processIdentifier,
        !peer.isTerminated,
        let peerLaunchedAt = peer.launchDate,
        peer.bundleURL?.canonicalBundleURL == bundle
      else { return false }
      return peerLaunchedAt < launchedAt
    }
  }
}

/// The launch sequence of the menu-bar app, separated from `NSApplicationDelegate` so every branch
/// runs under test: helper roles first, then the wait for a relauncher that promised to exit, then
/// the single-instance decision.
@MainActor
struct ApplicationLaunchCoordinator {
  enum Outcome: Equatable, Sendable {
    /// A smoke snapshot or login-item handshake ran; the process has nothing else to do.
    case helperRoleHandled
    case stoodDown
    case running
  }

  var runSmokeHarness: @MainActor ([String], URL) async -> Bool
  var handleLoginRegistration: @MainActor ([String], URL) async -> Bool
  var currentInstance: @MainActor () -> any RunningInstance
  var bundleURL: URL
  var runningPeers: @MainActor () -> [any RunningInstance]
  var isProcessRunning: @MainActor (pid_t) -> Bool
  var sleep: @MainActor (TimeInterval) async -> Void

  func launch(arguments: [String], dataDirectory: URL) async -> Outcome {
    if await runSmokeHarness(arguments, dataDirectory) { return .helperRoleHandled }
    if await handleLoginRegistration(arguments, dataDirectory) { return .helperRoleHandled }
    if let predecessor = SingleInstancePolicy.predecessor(in: arguments) {
      _ = await waitForExit(of: predecessor)
    }
    let standsDown = SingleInstancePolicy.shouldStandDown(
      current: currentInstance(),
      bundleURL: bundleURL,
      peers: runningPeers()
    )
    return standsDown ? .stoodDown : .running
  }

  /// Bounded: a predecessor that never exits must not keep the menu bar empty.
  func waitForExit(of processIdentifier: pid_t) async -> Bool {
    var polls = 0
    while isProcessRunning(processIdentifier) {
      guard polls < SingleInstancePolicy.predecessorPollLimit else { return false }
      polls += 1
      await sleep(SingleInstancePolicy.predecessorPollInterval)
    }
    return true
  }
}
