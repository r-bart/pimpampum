import Foundation
import Testing

@testable import PimpampumMenuBar

private struct FakeInstance: RunningInstance {
  let processIdentifier: pid_t
  let launchDate: Date?
  var bundleURL: URL? = URL(fileURLWithPath: "/Applications/Pimpampum.app", isDirectory: true)
  var isTerminated = false
}

/// Registering the login item makes macOS start the app, and once setup adopts a copy the user
/// already placed in an Applications folder, that is the bundle already running. Two menu-bar icons
/// appeared. The newcomer stands down, but only for a copy of the same bundle.
@Suite("Single menu-bar instance")
@MainActor
struct SingleInstanceTests {
  private let epoch = Date(timeIntervalSince1970: 1_000)
  private let bundle = URL(fileURLWithPath: "/Applications/Pimpampum.app", isDirectory: true)

  private func standsDown(_ current: FakeInstance, peers: [FakeInstance]) -> Bool {
    SingleInstancePolicy.shouldStandDown(current: current, bundleURL: bundle, peers: peers)
  }

  @Test
  func aNewerCopyStandsDownForAnOlderOne() {
    let older = FakeInstance(processIdentifier: 10, launchDate: epoch)
    let newer = FakeInstance(processIdentifier: 20, launchDate: epoch.addingTimeInterval(60))
    #expect(standsDown(newer, peers: [older, newer]))
  }

  @Test
  func theOlderCopyKeepsRunning() {
    let older = FakeInstance(processIdentifier: 10, launchDate: epoch)
    let newer = FakeInstance(processIdentifier: 20, launchDate: epoch.addingTimeInterval(60))
    #expect(!standsDown(older, peers: [older, newer]))
  }

  @Test
  func aLoneCopyNeverStandsDown() {
    let only = FakeInstance(processIdentifier: 10, launchDate: epoch)
    #expect(!standsDown(only, peers: [only]))
    #expect(!standsDown(only, peers: []))
  }

  @Test
  func anUnknownLaunchDateNeverLeavesTheMenuBarEmpty() {
    // Standing down on missing information could terminate every copy. Ties do the same.
    let unknown = FakeInstance(processIdentifier: 20, launchDate: nil)
    let other = FakeInstance(processIdentifier: 10, launchDate: epoch)
    #expect(!standsDown(unknown, peers: [other]))

    let sameMoment = FakeInstance(processIdentifier: 30, launchDate: epoch)
    #expect(!standsDown(sameMoment, peers: [other]))

    let peerWithoutDate = FakeInstance(processIdentifier: 40, launchDate: nil)
    let current = FakeInstance(processIdentifier: 50, launchDate: epoch)
    #expect(!standsDown(current, peers: [peerWithoutDate]))
  }

  @Test
  func aCopyRunningFromAnotherPathIsNotADuplicate() {
    // The install copies the Downloads bundle into ~/Applications and opens it while the Downloads
    // copy is still alive. The installed copy is the one that must survive, so an older peer at a
    // different path must never make it exit. The same rule keeps a newer build launched from
    // Downloads alive beside an older adopted version.
    let downloads = FakeInstance(
      processIdentifier: 10,
      launchDate: epoch,
      bundleURL: URL(fileURLWithPath: "/Users/example/Downloads/Pimpampum.app", isDirectory: true)
    )
    let installed = FakeInstance(
      processIdentifier: 20,
      launchDate: epoch.addingTimeInterval(60),
      bundleURL: bundle
    )
    #expect(!standsDown(installed, peers: [downloads, installed]))

    let unknownPath = FakeInstance(processIdentifier: 30, launchDate: epoch, bundleURL: nil)
    #expect(!standsDown(installed, peers: [unknownPath]))
  }

  @Test
  func aPeerThatAlreadyEndedDoesNotCount() {
    // LaunchServices can still list the copy that just called terminate. Standing down for it
    // would leave no menu-bar app at all.
    let ended = FakeInstance(processIdentifier: 10, launchDate: epoch, isTerminated: true)
    let newer = FakeInstance(processIdentifier: 20, launchDate: epoch.addingTimeInterval(60))
    #expect(!standsDown(newer, peers: [ended]))
  }

  @Test
  func comparesBundlePathsAfterResolvingSymlinks() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-instance-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let real = root.appendingPathComponent("Real/Pimpampum.app", isDirectory: true)
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    let link = root.appendingPathComponent("Link")
    try FileManager.default.createSymbolicLink(
      at: link, withDestinationURL: root.appendingPathComponent("Real"))
    let throughLink = link.appendingPathComponent("Pimpampum.app", isDirectory: true)

    let older = FakeInstance(processIdentifier: 10, launchDate: epoch, bundleURL: real)
    let newer = FakeInstance(
      processIdentifier: 20, launchDate: epoch.addingTimeInterval(60), bundleURL: throughLink)
    #expect(
      SingleInstancePolicy.shouldStandDown(current: newer, bundleURL: throughLink, peers: [older]))
  }

  @Test
  func namesThePredecessorOnTheCommandLine() {
    #expect(SingleInstancePolicy.relaunchArguments(from: 4_242) == ["--relaunched-from", "4242"])
    #expect(SingleInstancePolicy.predecessor(in: ["--relaunched-from", "4242"]) == 4_242)
    #expect(SingleInstancePolicy.predecessor(in: ["--other", "--relaunched-from", "7"]) == 7)
    // Anything but a well-formed positive pid is ignored rather than waited on.
    #expect(SingleInstancePolicy.predecessor(in: []) == nil)
    #expect(SingleInstancePolicy.predecessor(in: ["--relaunched-from"]) == nil)
    #expect(SingleInstancePolicy.predecessor(in: ["--relaunched-from", "abc"]) == nil)
    #expect(SingleInstancePolicy.predecessor(in: ["--relaunched-from", "0"]) == nil)
    #expect(SingleInstancePolicy.predecessor(in: ["--relaunched-from", "-3"]) == nil)
    #expect(SingleInstancePolicy.predecessorPollLimit == 50)
  }
}

@MainActor
private final class LaunchRecorder {
  var smokeCalls = 0
  var loginCalls = 0
  var sleeps: [TimeInterval] = []
  var runningChecks = 0
  var smokeHandles = false
  var loginHandles = false
  var exitsAfterChecks = Int.max
  var peers: [FakeInstance] = []
  let current = FakeInstance(
    processIdentifier: 20, launchDate: Date(timeIntervalSince1970: 1_060))

  func coordinator() -> ApplicationLaunchCoordinator {
    ApplicationLaunchCoordinator(
      runSmokeHarness: { _, _ in
        self.smokeCalls += 1
        return self.smokeHandles
      },
      handleLoginRegistration: { _, _ in
        self.loginCalls += 1
        return self.loginHandles
      },
      currentInstance: { self.current },
      bundleURL: URL(fileURLWithPath: "/Applications/Pimpampum.app", isDirectory: true),
      runningPeers: { self.peers },
      isProcessRunning: { _ in
        self.runningChecks += 1
        return self.runningChecks <= self.exitsAfterChecks
      },
      sleep: { seconds in self.sleeps.append(seconds) }
    )
  }
}

@Suite("Application launch coordinator")
@MainActor
struct ApplicationLaunchCoordinatorTests {
  private let dataDirectory = URL(fileURLWithPath: "/Users/example/.pimpampum", isDirectory: true)

  @Test
  func helperRolesEndTheProcessBeforeAnyInstanceDecision() async {
    let smoke = LaunchRecorder()
    smoke.smokeHandles = true
    let smokeOutcome = await smoke.coordinator().launch(
      arguments: ["--ui-smoke-snapshot"], dataDirectory: dataDirectory)
    #expect(smokeOutcome == .helperRoleHandled)
    #expect(smoke.loginCalls == 0)

    let login = LaunchRecorder()
    login.loginHandles = true
    let loginOutcome = await login.coordinator().launch(
      arguments: ["--register-login-item", "request"], dataDirectory: dataDirectory)
    #expect(loginOutcome == .helperRoleHandled)
    #expect(login.smokeCalls == 1)
  }

  @Test
  func aNormalLaunchKeepsRunningAndStandsDownOnlyForAnOlderTwin() async {
    let alone = LaunchRecorder()
    #expect(await alone.coordinator().launch(arguments: [], dataDirectory: dataDirectory) == .running)
    #expect(alone.sleeps.isEmpty)

    let twin = LaunchRecorder()
    twin.peers = [FakeInstance(processIdentifier: 10, launchDate: Date(timeIntervalSince1970: 1_000))]
    #expect(await twin.coordinator().launch(arguments: [], dataDirectory: dataDirectory) == .stoodDown)
  }

  @Test
  func waitsForTheRelauncherToExitBeforeJudgingPeers() async {
    // The Downloads copy launches the installed one and then terminates. Until it is gone it is an
    // older process in the list, so the newcomer waits for the pid it was given.
    let recorder = LaunchRecorder()
    recorder.exitsAfterChecks = 2
    let outcome = await recorder.coordinator().launch(
      arguments: ["--relaunched-from", "10"], dataDirectory: dataDirectory)
    #expect(outcome == .running)
    #expect(recorder.sleeps == [0.1, 0.1])
    #expect(recorder.runningChecks == 3)
  }

  @Test
  func theWaitIsBounded() async {
    // A predecessor that never exits must not keep the menu bar empty.
    let recorder = LaunchRecorder()
    let exited = await recorder.coordinator().waitForExit(of: 10)
    #expect(!exited)
    #expect(recorder.sleeps.count == SingleInstancePolicy.predecessorPollLimit)
  }
}
