import AppKit
import Combine
import SwiftUI

@MainActor
final class BackupSettingsWindowController: ObservableObject, SettingsWindowOpening {
  private let store: BackupSettingsStore
  private(set) var windowController: NSWindowController?
  private(set) var refreshTask: Task<Void, Never>?

  init(store: BackupSettingsStore) {
    self.store = store
  }

  func openSettings() {
    let controller = windowController ?? makeWindowController()
    windowController = controller
    NSApplication.shared.activate(ignoringOtherApps: true)
    controller.showWindow(nil)
    controller.window?.makeKeyAndOrderFront(nil)
    controller.window?.orderFrontRegardless()
    controller.window?.makeMain()
    controller.window?.makeKey()
    refreshTask = Task { await store.load() }
  }

  private func makeWindowController() -> NSWindowController {
    let content = BackupSettingsView(store: store)
    let window = NSWindow(contentViewController: NSHostingController(rootView: content))
    window.title = "Pimpampum Settings"
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.contentMinSize = NSSize(
      width: BackupSettingsView.contentWidth,
      height: BackupSettingsView.contentHeight
    )
    window.contentMaxSize = NSSize(
      width: BackupSettingsView.contentWidth,
      height: .greatestFiniteMagnitude
    )
    window.setContentSize(
      NSSize(
        width: BackupSettingsView.contentWidth,
        height: BackupSettingsView.contentHeight
      )
    )
    window.isReleasedWhenClosed = false
    window.center()
    return NSWindowController(window: window)
  }
}
