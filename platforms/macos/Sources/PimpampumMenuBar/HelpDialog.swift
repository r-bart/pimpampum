import SwiftUI

struct HelpDialogItem: Identifiable, Equatable {
  let id: String
  let systemImage: String
  let text: String
}

enum HelpDialogCopy {
  static let buttonTitle = "How it works"
  static let title = "How Pimpampum works"
  static let introduction = "Pimpampum is a local, agent-first project manager."
  static let done = "Done"

  static let items = [
    HelpDialogItem(
      id: "local",
      systemImage: "desktopcomputer",
      text: "Pimpampum runs locally on this machine."
    ),
    HelpDialogItem(
      id: "projects",
      systemImage: "doc.text",
      text: "Projects contain Specs; Specs may contain tasks and optional subtasks."
    ),
    HelpDialogItem(
      id: "agents",
      systemImage: "terminal",
      text: "Agents interact through MCP, the CLI, or the local API."
    ),
    HelpDialogItem(
      id: "claims",
      systemImage: "person.crop.circle.badge.checkmark",
      text: "Claimed work appears under Active work and in the menu-bar count."
    ),
    HelpDialogItem(
      id: "finder",
      systemImage: "folder",
      text: "Clicking a project opens its workspace in Finder."
    ),
    HelpDialogItem(
      id: "sync",
      systemImage: "arrow.triangle.2.circlepath",
      text: "Synchronization shares portfolio changes through a folder managed by your sync provider."
    ),
    HelpDialogItem(
      id: "backup",
      systemImage: "externaldrive",
      text: "Backup keeps a separate recovery copy; it does not synchronize other computers."
    ),
  ]
}

@MainActor
struct HelpDialog: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 6) {
        Text(HelpDialogCopy.title)
          .font(.title2.weight(.semibold))
        Text(HelpDialogCopy.introduction)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      VStack(alignment: .leading, spacing: 12) {
        ForEach(HelpDialogCopy.items) { item in
          Label {
            Text(item.text)
              .fixedSize(horizontal: false, vertical: true)
          } icon: {
            Image(systemName: item.systemImage)
              .frame(width: 18)
              .foregroundStyle(.secondary)
          }
        }
      }
      .font(.subheadline)

      HStack {
        Spacer()
        Button(HelpDialogCopy.done) { dismiss() }
          .keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 440)
  }
}
