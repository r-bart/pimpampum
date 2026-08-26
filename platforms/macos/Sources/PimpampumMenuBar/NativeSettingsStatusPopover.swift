import SwiftUI

@MainActor
struct NativeSettingsStatusPopover: View {
  @ObservedObject var store: OverviewStore
  let workspaceOpener: any WorkspaceOpening
  let settingsWindowOpener: any SettingsWindowOpening
  let quitApplication: @MainActor () -> Void

  var body: some View {
    StatusPopover(
      store: store,
      workspaceOpener: workspaceOpener,
      settingsWindowOpener: settingsWindowOpener,
      quitApplication: quitApplication
    )
  }
}
