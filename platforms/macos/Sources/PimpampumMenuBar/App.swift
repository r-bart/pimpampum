import AppKit
import SwiftUI

extension NSRunningApplication: RunningInstance {}

extension ApplicationLaunchCoordinator {
  /// The real launch sequence. Every decision lives in the covered coordinator; this only names
  /// the system calls it makes.
  static var live: ApplicationLaunchCoordinator {
    ApplicationLaunchCoordinator(
      runSmokeHarness: { arguments, dataDirectory in
        await DesktopSmokeHarness.run(arguments: arguments, dataDirectory: dataDirectory)
      },
      handleLoginRegistration: { arguments, dataDirectory in
        await LoginRegistrationCoordinator().handle(
          arguments: arguments,
          dataDirectory: dataDirectory
        )
      },
      currentInstance: { NSRunningApplication.current },
      bundleURL: Bundle.main.bundleURL,
      runningPeers: {
        NSRunningApplication.runningApplications(
          withBundleIdentifier: Bundle.main.bundleIdentifier ?? ""
        )
      },
      isProcessRunning: { processIdentifier in
        NSRunningApplication(processIdentifier: processIdentifier).map { !$0.isTerminated }
          ?? false
      },
      sleep: { seconds in
        try? await Task.sleep(for: .seconds(seconds))
      }
    )
  }
}

@MainActor
final class PimpampumApplicationDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    let dataDirectory = ApplicationConfiguration.dataDirectory()
    Task { @MainActor in
      let arguments = Array(ProcessInfo.processInfo.arguments.dropFirst())
      let outcome = await ApplicationLaunchCoordinator.live.launch(
        arguments: arguments,
        dataDirectory: dataDirectory
      )
      // Registering the login item makes macOS start the app, and once setup adopts a copy the user
      // already placed in an Applications folder that is the very bundle already running. A
      // menu-bar app has no reason to run twice, so the newcomer stands down and the user keeps the
      // window they were using.
      if outcome != .running {
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
  @StateObject private var setupSession: SetupSession
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
    let overviewStore = OverviewStore(reader: client)
    _store = StateObject(wrappedValue: overviewStore)
    // The setup session belongs to the app, not to the popover branch that shows it, so a setup in
    // progress survives every poll and every help button.
    _setupSession = StateObject(
      wrappedValue: SetupSession.bundled(overviewStore: overviewStore)
    )
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
        setupSession: setupSession,
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
