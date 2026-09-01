import AppKit
import SwiftUI

@MainActor
struct NativeSettingsStatusPopover: View {
  @ObservedObject var store: OverviewStore
  @ObservedObject var setupSession: SetupSession
  let workspaceOpener: any WorkspaceOpening
  let settingsWindowOpener: any SettingsWindowOpening
  let quitApplication: @MainActor () -> Void

  var body: some View {
    StatusPopover(
      store: store,
      setupSession: setupSession,
      workspaceOpener: workspaceOpener,
      settingsWindowOpener: PopoverDismissingSettingsWindowOpener(
        settingsWindowOpener: settingsWindowOpener,
        dismissPopover: {
          let application = NSApplication.shared
          let popoverWindow = application.keyWindow.flatMap { window in
            window.styleMask.contains(.titled) ? nil : window
          } ?? application.orderedWindows.first { window in
            window.isVisible && !window.styleMask.contains(.titled)
          }
          popoverWindow?.orderOut(nil)
        }
      ),
      quitApplication: quitApplication
    )
  }
}
