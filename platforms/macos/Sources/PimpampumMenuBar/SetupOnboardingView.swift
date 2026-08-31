import AppKit
import SwiftUI

enum SetupOnboardingStep: Int, CaseIterable, Sendable {
  case explain = 1
  case agents = 2
  case progress = 3

  var marker: String {
    switch self {
    case .explain: "1 OF 3"
    case .agents: "2 OF 3"
    case .progress: "3 OF 3"
    }
  }
}

enum SetupOnboardingCopy {
  static let title = "One private home for agent context"
  static let detail =
    "Pimpampum keeps shared project memory on this Mac, starts at sign-in, and stays available when this menu closes. You can remove it later."
  static let changeSummary =
    "Install and verify the private service, enable start at sign-in, and connect only the agents selected below."
}

@MainActor
struct SetupAssistant {
  var registerLoginItem: () -> Void = {
    let service = MainAppLoginItemService()
    guard service.state == .error else { return }
    try? service.register()
  }

  func prepareApp() { registerLoginItem() }
}

@MainActor
struct SetupOnboardingView: View {
  @StateObject private var store: SetupStore
  let onFinished: () -> Void

  @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
  @State private var step: SetupOnboardingStep = .explain

  init(store: SetupStore, onFinished: @escaping () -> Void) {
    _store = StateObject(wrappedValue: store)
    self.onFinished = onFinished
  }

  init(assistant _: SetupAssistant, onCheckAgain: @escaping () -> Void) {
    _store = StateObject(wrappedValue: SetupStore.bundled())
    onFinished = onCheckAgain
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        stepHeader

        switch step {
        case .explain: explanation
        case .agents: agentSelection
        case .progress: progressContent
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxHeight: 480)
    .fixedSize(horizontal: false, vertical: true)
    .onAppear {
      store.start()
      showDurableProgressIfNeeded()
    }
    .onChange(of: store.activity) { _ in showDurableProgressIfNeeded() }
    .onChange(of: store.completion) { _ in showDurableProgressIfNeeded() }
    .animation(accessibilityReduceMotion ? nil : .easeInOut(duration: 0.18), value: step)
  }

  private var stepHeader: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(step.marker)
        .font(.caption2.weight(.semibold))
        .tracking(0.8)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Step \(step.rawValue) of 3")

      Text(stepTitle)
        .font(.title2.weight(.semibold))
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
    }
  }

  private var stepTitle: String {
    switch step {
    case .explain: SetupOnboardingCopy.title
    case .agents: "Choose where context is available"
    case .progress: "Setting up your private service"
    }
  }

  private var explanation: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(SetupOnboardingCopy.detail)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      VStack(alignment: .leading, spacing: 10) {
        trustRow("Private to your account", symbol: "lock.shield")
        trustRow("Available when this menu is closed", symbol: "circle.dotted.circle")
        trustRow("Reversible from Settings", symbol: "arrow.uturn.backward.circle")
      }

      Button("Continue") { move(to: .agents) }
        .buttonStyle(GuidedPrimaryButtonStyle())
        .keyboardShortcut(.defaultAction)
        .accessibilityLabel("Continue to detected agents")
    }
  }

  private var agentSelection: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 5) {
        Text("Detected agents")
          .font(.headline)
        Text("Ready to connect")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      if store.activity == .detecting && store.agents.isEmpty {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Looking for supported agents…")
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Looking for supported agents")
      } else {
        VStack(spacing: 8) {
          ForEach(store.agents) { agent in
            Toggle(
              isOn: Binding(
                get: { agent.selected },
                set: { store.setSelected($0, for: agent.id) }
              )
            ) {
              VStack(alignment: .leading, spacing: 2) {
                Text(agent.id.displayName)
                  .foregroundStyle(.primary)
                Text(agent.detected ? "Detected on this Mac" : "Not detected")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
            .toggleStyle(.switch)
            .disabled(!agent.detected || store.busy)
            .frame(minHeight: 44)
            .accessibilityLabel("Select \(agent.id.displayName)")
            .accessibilityValue(agent.selected ? "Selected" : "Not selected")
          }
        }
      }

      VStack(alignment: .leading, spacing: 6) {
        Text("Exact changes")
          .font(.subheadline.weight(.semibold))
        Text(SetupOnboardingCopy.changeSummary)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        ForEach(store.selectedAgents, id: \.self) { id in
          Label("Connect \(id.displayName)", systemImage: "checkmark.circle")
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Connect \(id.displayName)")
        }
      }
      .padding(12)
      .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

      if let errorMessage = store.errorMessage {
        inlineError(errorMessage)
      }

      HStack(spacing: 10) {
        Button("Back") { move(to: .explain) }
          .buttonStyle(GuidedSecondaryButtonStyle())
          .keyboardShortcut(.cancelAction)
          .accessibilityLabel("Back to private service explanation")

        Button("Review & set up") { reviewAndSetUp() }
          .buttonStyle(GuidedPrimaryButtonStyle())
          .keyboardShortcut(.defaultAction)
          .disabled(!store.canReview)
          .accessibilityLabel("Review and set up selected agents")
      }
    }
  }

  private var progressContent: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("You can close this menu. Setup continues safely and resumes here when reopened.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      progressRow(
        title: "Private service",
        state: store.service.state,
        symbol: "lock.shield"
      )

      ForEach(store.agentResults) { agent in
        agentProgressRow(agent)
      }

      if store.busy {
        ProgressView()
          .controlSize(.small)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityLabel("Setup in progress")
      }

      if let errorMessage = store.errorMessage {
        inlineError(errorMessage)
      }

      if !store.unresolvedConflicts.isEmpty {
        conflictRecovery
      }

      if store.needsLoginItemApproval {
        VStack(alignment: .leading, spacing: 8) {
          Text("Allow start at sign-in")
            .font(.subheadline.weight(.semibold))
          Text("macOS needs your approval in Login Items. Connected agents remain available.")
            .font(.caption)
            .foregroundStyle(.secondary)
          Button("Open Login Items Settings") { LoginApprovalSettings.open() }
            .buttonStyle(GuidedSecondaryButtonStyle())
            .accessibilityLabel("Open Login Items Settings")
        }
      }

      if store.completion?.nextAction == .newSession {
        Text(GuidedSetupRecoveryCopy.newSession)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if store.completion?.status == .complete {
        Button("Done", action: onFinished)
          .buttonStyle(GuidedPrimaryButtonStyle())
          .keyboardShortcut(.defaultAction)
          .accessibilityLabel("Finish setup")
      }
    }
  }

  private func agentProgressRow(_ agent: SetupAgentPresentation) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      progressRow(
        title: agent.id.displayName,
        state: agent.state,
        symbol: "person.crop.circle"
      )
      Text(
        agent.configured
          ? agent.available
            ? "Configured · Available in the current session"
            : "Configured · Not available in the current session"
          : "Not configured"
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .accessibilityLabel(
        "\(agent.id.displayName), configured \(agent.configured ? "yes" : "no"), current session available \(agent.available ? "yes" : "no")"
      )

      if agent.state == .needsRepair {
        Button(GuidedSetupRecoveryCopy.retry) {
          Task { await store.retry(agent.id) }
        }
        .buttonStyle(GuidedSecondaryButtonStyle())
        .disabled(store.busy)
        .accessibilityLabel("Try \(agent.id.displayName) again")
      }

      if agent.state == .connected || agent.state == .newSessionRequired {
        Button("Open \(agent.id.displayName)") { openAgent(agent.id) }
          .buttonStyle(GuidedSecondaryButtonStyle())
          .accessibilityLabel("Open \(agent.id.displayName)")
      }
    }
  }

  private var conflictRecovery: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Configuration conflict")
        .font(.headline)
      Text("Nothing was replaced. Review the existing entry and choose what Pimpampum should do.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      ForEach(store.unresolvedConflicts, id: \.connectorId) { conflict in
        VStack(alignment: .leading, spacing: 8) {
          Text(conflict.connectorId.displayName)
            .font(.subheadline.weight(.semibold))
          Text(SetupStore.sanitize(conflict.comparison))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 8) {
            Button("Keep existing") {
              Task { await store.resolveConflict(conflict.connectorId, decision: .keep) }
            }
            .buttonStyle(GuidedSecondaryButtonStyle())
            .accessibilityLabel("Keep existing \(conflict.connectorId.displayName) configuration")

            Button("Replace") {
              Task { await store.resolveConflict(conflict.connectorId, decision: .replace) }
            }
            .buttonStyle(GuidedPrimaryButtonStyle())
            .accessibilityLabel("Replace \(conflict.connectorId.displayName) configuration")
          }
        }
      }

      Button("Cancel") {
        store.cancelConflict()
        move(to: .agents)
      }
      .buttonStyle(GuidedSecondaryButtonStyle())
      .keyboardShortcut(.cancelAction)
      .accessibilityLabel("Cancel setup without replacing configuration")
    }
    .padding(12)
    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private func trustRow(_ title: String, symbol: String) -> some View {
    Label(title, systemImage: symbol)
      .font(.subheadline)
      .foregroundStyle(.primary)
      .frame(minHeight: 44, alignment: .leading)
      .accessibilityLabel(title)
  }

  private func progressRow(
    title: String,
    state: SetupComponentState,
    symbol: String
  ) -> some View {
    HStack(spacing: 10) {
      Image(systemName: symbol)
        .frame(width: 20)
        .foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).foregroundStyle(.primary)
        Text(state.label)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 8)
      if state == .connecting { ProgressView().controlSize(.small) }
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(title), \(state.accessibilityLabel)")
  }

  private func inlineError(_ message: String) -> some View {
    Label(message, systemImage: "exclamationmark.triangle")
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel("Setup issue. \(message)")
  }

  private func reviewAndSetUp() {
    Task {
      await store.review()
      guard store.plan != nil, store.errorMessage == nil else { return }
      move(to: .progress)
      guard store.plan?.conflicts.isEmpty == true else { return }
      await store.apply()
      if store.completion?.status == .complete { onFinished() }
    }
  }

  private func openAgent(_ id: SetupAgentID) {
    let candidates: [URL]
    switch id {
    case .codex:
      candidates = [
        URL(fileURLWithPath: "/Applications/Codex.app"),
        FileManager.default.homeDirectoryForCurrentUser
          .appendingPathComponent("Applications/Codex.app"),
      ]
    case .claudeCode:
      candidates = [
        URL(fileURLWithPath: "/Applications/Claude.app"),
        FileManager.default.homeDirectoryForCurrentUser
          .appendingPathComponent("Applications/Claude.app"),
      ]
    }
    guard
      let application = candidates.first(where: { candidate in
        guard
          let values = try? candidate.resourceValues(forKeys: [
            .isDirectoryKey, .isSymbolicLinkKey,
          ])
        else { return false }
        return values.isDirectory == true && values.isSymbolicLink != true
      })
    else { return }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.createsNewApplicationInstance = false
    NSWorkspace.shared.openApplication(at: application, configuration: configuration)
  }

  private func showDurableProgressIfNeeded() {
    if store.activity.hasBegunMutation || !store.progress.isEmpty || store.completion != nil {
      move(to: .progress)
    }
  }

  private func move(to next: SetupOnboardingStep) {
    if accessibilityReduceMotion {
      step = next
    } else {
      withAnimation(.easeInOut(duration: 0.18)) { step = next }
    }
  }
}

private struct GuidedPrimaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.semibold))
      .foregroundStyle(Color(nsColor: .windowBackgroundColor))
      .padding(.horizontal, 14)
      .frame(maxWidth: .infinity, minHeight: 44)
      .background(.primary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .opacity(configuration.isPressed ? 0.78 : 1)
  }
}

private struct GuidedSecondaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.medium))
      .foregroundStyle(.primary)
      .padding(.horizontal, 14)
      .frame(maxWidth: .infinity, minHeight: 44)
      .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .opacity(configuration.isPressed ? 0.72 : 1)
  }
}
