import SwiftUI

@MainActor
struct UpdateSettingsView: View {
  @ObservedObject var store: UpdateSettingsStore

  var body: some View {
    let presentation = store.presentation
    Form {
      Section("Updates") {
        if let installedVersion = presentation.installedVersion {
          LabeledContent("Installed", value: installedVersion)
        }
        if let latestVersion = presentation.latestVersion {
          LabeledContent("Latest", value: latestVersion)
        }
        Text(presentation.explanation).foregroundStyle(.secondary)
        if let relaunchNotice = presentation.relaunchNotice {
          Label(relaunchNotice, systemImage: "arrow.clockwise")
        }
        if let errorMessage = presentation.errorMessage {
          Label(errorMessage, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
        }
        Button(presentation.actionTitle) { Task { await store.act() } }
          .disabled(!presentation.actionEnabled)
      }
    }
    .formStyle(.grouped)
  }
}
