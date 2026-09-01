import AppKit
import SwiftUI

/// What a launching instance needs to know about the copies already running, so the decision can be
/// tested without an NSRunningApplication.
protocol RunningInstance {
  var processIdentifier: pid_t { get }
  var launchDate: Date? { get }
}

extension NSRunningApplication: RunningInstance {}

@MainActor
final class PimpampumApplicationDelegate: NSObject, NSApplicationDelegate {
  /// True when an older copy of this bundle is already running. Ties and unknown launch dates keep
  /// the newcomer alive rather than risk leaving the menu bar with no app at all.
  static func shouldStandDown(current: any RunningInstance, peers: [any RunningInstance]) -> Bool {
    guard let launchedAt = current.launchDate else { return false }
    return peers.contains { peer in
      guard peer.processIdentifier != current.processIdentifier,
        let peerLaunchedAt = peer.launchDate
      else { return false }
      return peerLaunchedAt < launchedAt
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let dataDirectory = ApplicationConfiguration.dataDirectory()
    Task { @MainActor in
      let arguments = Array(ProcessInfo.processInfo.arguments.dropFirst())
      let smokeHandled = await DesktopSmokeHarness.run(
        arguments: arguments,
        dataDirectory: dataDirectory
      )
      let loginHandled =
        smokeHandled
        ? false
        : await LoginRegistrationCoordinator().handle(
          arguments: arguments,
          dataDirectory: dataDirectory
        )
      if smokeHandled || loginHandled {
        NSApplication.shared.terminate(nil)
        return
      }
      // Registering the login item makes macOS start the app, and once setup adopts a copy the user
      // already placed in an Applications folder that is the very bundle already running. A
      // menu-bar app has no reason to run twice, so the newcomer stands down and the user keeps the
      // window they were using.
      if Self.shouldStandDown(
        current: NSRunningApplication.current,
        peers: NSRunningApplication.runningApplications(
          withBundleIdentifier: Bundle.main.bundleIdentifier ?? ""
        )
      ) {
        NSApplication.shared.terminate(nil)
      }
    }
  }
}

@main
@MainActor
struct PimpampumMenuBarApp: App {
  @NSApplicationDelegateAdaptor(PimpampumApplicationDelegate.self) private var appDelegate
  @StateObject private var store: OverviewStore
  @StateObject private var settingsWindowController: SyncSettingsWindowController
  private let workspaceOpener = WorkspaceOpener()

  init() {
    let dataDirectory = ApplicationConfiguration.dataDirectory()
    let client = OverviewClient(
      receiptURL: dataDirectory.appendingPathComponent("install-receipt.json"),
      tokenURL: dataDirectory.appendingPathComponent("token")
    )
    let syncClient = SyncSettingsClient(
      receiptURL: dataDirectory.appendingPathComponent("install-receipt.json"),
      tokenURL: dataDirectory.appendingPathComponent("token")
    )
    let syncSettingsStore = SyncSettingsStore(client: syncClient)
    let backupClient = BackupSettingsClient(
      receiptURL: dataDirectory.appendingPathComponent("install-receipt.json"),
      tokenURL: dataDirectory.appendingPathComponent("token")
    )
    let backupSettingsStore = BackupSettingsStore(client: backupClient)
    let updateSettingsStore = UpdateSettingsStore(
      receiptURL: dataDirectory.appendingPathComponent("install-receipt.json")
    )
    let agentSettingsStore = AgentSettingsStore.bundled()
    _store = StateObject(wrappedValue: OverviewStore(reader: client))
    _settingsWindowController = StateObject(
      wrappedValue: SyncSettingsWindowController(
        syncStore: syncSettingsStore,
        backupStore: backupSettingsStore,
        updateStore: updateSettingsStore,
        agentStore: agentSettingsStore
      )
    )
  }

  var body: some Scene {
    MenuBarExtra {
      NativeSettingsStatusPopover(
        store: store,
        workspaceOpener: workspaceOpener,
        settingsWindowOpener: settingsWindowController,
        quitApplication: { NSApplication.shared.terminate(nil) }
      )
      .onAppear {
        store.start()
        store.setPopoverOpen(true)
      }
      .onDisappear {
        store.setPopoverOpen(false)
      }
    } label: {
      StatusIndicator(
        state: StatusPopover.visualState(
          connectionState: store.connectionState,
          overview: store.overview
        ),
        activeCount: StatusPopover.visibleActiveCount(
          connectionState: store.connectionState,
          overview: store.overview
        ),
        showsActiveCount: false
      )
      .task {
        store.start()
      }
    }
    .menuBarExtraStyle(.window)
  }
}
