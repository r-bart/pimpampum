import SwiftUI

/// Plain-language explanation of each planned change, shown behind the help button so the
/// confirmation list itself stays short. Principle 6 of the spec: normal users see simple states,
/// advanced users can inspect paths.
enum SetupChangesHelpCopy {
  static let buttonTitle = "What these changes mean"
  static let title = "What these changes mean"
  static let introduction =
    "Pimpampum only touches the places listed here. Nothing is uploaded, and everything can be removed later from Settings."
  static let done = "Done"
  static let locationLabel = "Where"

  static func detail(for kind: String) -> String {
    if kind.hasPrefix("connector:") {
      let name = kind == "connector:codex" ? "Codex" : "Claude Code"
      return
        "\(name) keeps a list of the tools it can use. Pimpampum adds one entry to that list so \(name) can see your projects. Anything else already in that file stays exactly as it is."
    }
    switch kind {
    case "runtime":
      return
        "Pimpampum brings its own copy of everything it needs. It never uses, changes, or depends on other software you have installed."
    case "service":
      return
        "A small program runs in the background so your agents can reach your work even when this menu is closed. It only answers requests coming from this Mac."
    case "data":
      return
        "Your projects, specs, and tasks are stored in a file on this Mac. Nothing is sent anywhere, and no account is required."
    case "login-item":
      return
        "Pimpampum starts with your session so your agents always find it. You can turn this off later in Settings."
    default:
      return
        "Pimpampum owns this change and records it, so removing Pimpampum later undoes it completely."
    }
  }
}

struct SetupChangesHelpDialog: View {
  let changes: [SetupChange]
  /// Closing is an explicit callback, and this view is rendered inside the popover rather than in
  /// a sheet. A sheet is a real window: the menu-bar popover loses key focus the moment one opens
  /// and closes itself, taking the whole setup with it.
  let onDone: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 6) {
        Text(SetupChangesHelpCopy.title)
          .font(.title2.weight(.semibold))
          .accessibilityAddTraits(.isHeader)

        Text(SetupChangesHelpCopy.introduction)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      VStack(alignment: .leading, spacing: 16) {
        ForEach(changes, id: \.kind) { change in
          VStack(alignment: .leading, spacing: 4) {
            Text(change.summary)
              .font(.subheadline.weight(.semibold))
              .fixedSize(horizontal: false, vertical: true)

            Text(SetupChangesHelpCopy.detail(for: change.kind))
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)

            if let path = change.path {
              Text("\(SetupChangesHelpCopy.locationLabel): \(path)")
                .font(.caption)
                .monospaced()
                .foregroundStyle(.tertiary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          .accessibilityElement(children: .combine)
        }
      }

      Button(SetupChangesHelpCopy.done) { onDone() }
        .buttonStyle(GuidedPrimaryButtonStyle())
        .keyboardShortcut(.cancelAction)
        .accessibilityLabel(SetupChangesHelpCopy.done)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
