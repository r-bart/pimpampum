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
  @StateObject private var backupSettingsStore: BackupSettingsStore
  private let workspaceOpener = WorkspaceOpener()

  init() {
    let dataDirectory = ApplicationConfiguration.dataDirectory()
    let client = OverviewClient(
      receiptURL: dataDirectory.appendingPathComponent("install-receipt.json"),
      tokenURL: dataDirectory.appendingPathComponent("token")
    )
    let backupClient = BackupSettingsClient(
      receiptURL: dataDirectory.appendingPathComponent("install-receipt.json"),
      tokenURL: dataDirectory.appendingPathComponent("token")
    )
    let backupSettingsStore = BackupSettingsStore(client: backupClient)
    _store = StateObject(wrappedValue: OverviewStore(reader: client))
    _backupSettingsStore = StateObject(wrappedValue: backupSettingsStore)
  }

  var body: some Scene {
    MenuBarExtra {
      NativeSettingsStatusPopover(
        store: store,
        workspaceOpener: workspaceOpener,
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
        )
      )
      .task {
        store.start()
      }
    }
    .menuBarExtraStyle(.window)

    Settings {
      BackupSettingsView(store: backupSettingsStore)
        .background(SettingsWindowConfigurator())
        .task {
          await backupSettingsStore.load()
        }
    }
  }
}
