import SwiftUI

@MainActor
struct NativeSettingsStatusPopover: View {
  @ObservedObject var store: OverviewStore
  let workspaceOpener: any WorkspaceOpening
  let quitApplication: @MainActor () -> Void

  var body: some View {
    if #available(macOS 14.0, *) {
      ModernNativeSettingsStatusPopover(
        store: store,
        workspaceOpener: workspaceOpener,
        quitApplication: quitApplication
      )
    } else {
      StatusPopover(
        store: store,
        workspaceOpener: workspaceOpener,
        settingsWindowOpener: SettingsWindowOpener(),
        quitApplication: quitApplication
      )
    }
  }
}

@available(macOS 14.0, *)
@MainActor
private struct ModernNativeSettingsStatusPopover: View {
  @Environment(\.openSettings) private var openSettings
  @ObservedObject var store: OverviewStore
  let workspaceOpener: any WorkspaceOpening
  let quitApplication: @MainActor () -> Void

  var body: some View {
    StatusPopover(
      store: store,
      workspaceOpener: workspaceOpener,
      settingsWindowOpener: NativeSettingsWindowOpener(action: openSettings),
      quitApplication: quitApplication
    )
  }
}

@available(macOS 14.0, *)
@MainActor
private struct NativeSettingsWindowOpener: SettingsWindowOpening {
  let action: OpenSettingsAction

  func openSettings() {
    action()
  }
}
