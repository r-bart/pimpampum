import AppKit
import SwiftUI

enum SetupOnboardingCopy {
  static let command =
    "npm install --global pimpampum && pimpampum install --service-only"
  static let title = "Finish setup from npm."
  static let detail =
    "The app is ready. Install the local service to connect the menu bar, CLI, and MCP on this Mac."
}

@MainActor
struct SetupAssistant {
  var registerLoginItem: () -> Void = {
    let service = MainAppLoginItemService()
    guard service.state == .error else { return }
    try? service.register()
  }
  var copyCommand: (String) -> Void = { command in
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(command, forType: .string)
  }
  var openTerminal: () -> Bool = {
    let workspace = NSWorkspace.shared
    let candidates = [
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/Utilities/Terminal.app",
    ]
    guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
      return false
    }
    return workspace.open(URL(fileURLWithPath: path))
  }

  func prepareApp() {
    registerLoginItem()
  }

  func begin() -> Bool {
    prepareApp()
    copyCommand(SetupOnboardingCopy.command)
    return openTerminal()
  }
}

@MainActor
struct SetupOnboardingView: View {
  let assistant: SetupAssistant
  let onCheckAgain: () -> Void

  @State private var actionMessage: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 8) {
        Text("One local service")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .textCase(.uppercase)
          .tracking(0.7)

        Text(SetupOnboardingCopy.title)
          .font(.title2.weight(.semibold))
          .accessibilityAddTraits(.isHeader)

        Text(SetupOnboardingCopy.detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      commandCard

      VStack(spacing: 8) {
        Button {
          actionMessage = assistant.begin()
            ? "Command copied. Paste it into Terminal and press Return."
            : "Command copied. Open Terminal, paste it and press Return."
        } label: {
          Label("Copy command and open Terminal", systemImage: "terminal")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(QuietPrimaryButtonStyle())
        .keyboardShortcut(.defaultAction)

        Button(action: onCheckAgain) {
          Text("I’ve installed it — check again")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(QuietSecondaryButtonStyle())

        if let actionMessage {
          Text(actionMessage)
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .transition(.opacity)
        }
      }

      Label(
        "Requires Node.js 22 or newer. Data stays in ~/.pimpampum. The app is added to Login Items.",
        systemImage: "lock.shield"
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var commandCard: some View {
    HStack(alignment: .center, spacing: 10) {
      Text(SetupOnboardingCopy.command)
        .font(.system(.caption, design: .monospaced))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)

      Spacer(minLength: 4)

      Button {
        assistant.copyCommand(SetupOnboardingCopy.command)
        actionMessage = "Command copied."
      } label: {
        Image(systemName: "doc.on.doc")
          .frame(width: 28, height: 28)
      }
      .buttonStyle(.plain)
      .contentShape(Rectangle())
      .accessibilityLabel("Copy setup command")
      .help("Copy setup command")
    }
    .padding(12)
    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

private struct QuietPrimaryButtonStyle: ButtonStyle {
  @Environment(\.colorScheme) private var colorScheme

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.semibold))
      .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
      .padding(.horizontal, 14)
      .frame(minHeight: 44)
      .background(
        colorScheme == .dark ? Color.white : Color.black,
        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
      )
      .opacity(configuration.isPressed ? 0.78 : 1)
      .scaleEffect(configuration.isPressed ? 0.985 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

private struct QuietSecondaryButtonStyle: ButtonStyle {
  @Environment(\.colorScheme) private var colorScheme

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.medium))
      .foregroundStyle(.primary)
      .padding(.horizontal, 14)
      .frame(minHeight: 44)
      .background(
        Color.primary.opacity(colorScheme == .dark ? 0.14 : 0.06),
        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(Color.primary.opacity(0.1), lineWidth: 1)
      }
      .opacity(configuration.isPressed ? 0.72 : 1)
      .scaleEffect(configuration.isPressed ? 0.985 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
