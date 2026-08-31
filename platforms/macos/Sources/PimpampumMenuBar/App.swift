import AppKit
import SwiftUI

@MainActor
final class PimpampumApplicationDelegate: NSObject, NSApplicationDelegate {
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
