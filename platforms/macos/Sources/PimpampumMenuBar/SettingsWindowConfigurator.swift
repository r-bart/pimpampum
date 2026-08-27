import AppKit
import SwiftUI

@MainActor
struct SettingsWindowConfigurator: NSViewRepresentable {
  final class WindowAttachmentView: NSView {
    var onWindowAttached: ((NSWindow) -> Void)?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let window { onWindowAttached?(window) }
    }
  }

  final class Coordinator {
    weak var configuredWindow: NSWindow?
  }

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeNSView(context: Context) -> NSView {
    let view = WindowAttachmentView(frame: .zero)
    view.onWindowAttached = { window in
      configure(window, coordinator: context.coordinator)
    }
    return view
  }

  func updateNSView(_ view: NSView, context: Context) {
    guard let window = view.window else { return }
    configure(window, coordinator: context.coordinator)
  }

  private func configure(_ window: NSWindow, coordinator: Coordinator) {
    guard coordinator.configuredWindow !== window else { return }
    coordinator.configuredWindow = window
    window.title = PimpampumBrand.settingsTitle
    window.toolbar = nil
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
    window.center()
  }
}
