import Foundation
import Testing

@testable import PimpampumMenuBar

private struct FakeInstance: RunningInstance {
  let processIdentifier: pid_t
  let launchDate: Date?
}

/// Registering the login item makes macOS start the app, and once setup adopts a copy the user
/// already placed in an Applications folder, that is the bundle already running. Two menu-bar icons
/// appeared. The newcomer stands down.
@Suite("Single menu-bar instance")
@MainActor
struct SingleInstanceTests {
  private let epoch = Date(timeIntervalSince1970: 1_000)

  @Test
  func aNewerCopyStandsDownForAnOlderOne() {
    let older = FakeInstance(processIdentifier: 10, launchDate: epoch)
    let newer = FakeInstance(processIdentifier: 20, launchDate: epoch.addingTimeInterval(60))
    #expect(PimpampumApplicationDelegate.shouldStandDown(current: newer, peers: [older, newer]))
  }

  @Test
  func theOlderCopyKeepsRunning() {
    let older = FakeInstance(processIdentifier: 10, launchDate: epoch)
    let newer = FakeInstance(processIdentifier: 20, launchDate: epoch.addingTimeInterval(60))
    #expect(!PimpampumApplicationDelegate.shouldStandDown(current: older, peers: [older, newer]))
  }

  @Test
  func aLoneCopyNeverStandsDown() {
    let only = FakeInstance(processIdentifier: 10, launchDate: epoch)
    #expect(!PimpampumApplicationDelegate.shouldStandDown(current: only, peers: [only]))
    #expect(!PimpampumApplicationDelegate.shouldStandDown(current: only, peers: []))
  }

  @Test
  func anUnknownLaunchDateNeverLeavesTheMenuBarEmpty() {
    // Standing down on missing information could terminate every copy. Ties do the same.
    let unknown = FakeInstance(processIdentifier: 20, launchDate: nil)
    let other = FakeInstance(processIdentifier: 10, launchDate: epoch)
    #expect(!PimpampumApplicationDelegate.shouldStandDown(current: unknown, peers: [other]))

    let sameMoment = FakeInstance(processIdentifier: 30, launchDate: epoch)
    #expect(!PimpampumApplicationDelegate.shouldStandDown(current: sameMoment, peers: [other]))

    let peerWithoutDate = FakeInstance(processIdentifier: 40, launchDate: nil)
    let current = FakeInstance(processIdentifier: 50, launchDate: epoch)
    #expect(!PimpampumApplicationDelegate.shouldStandDown(current: current, peers: [peerWithoutDate]))
  }
}
