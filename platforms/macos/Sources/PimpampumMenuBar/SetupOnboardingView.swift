import AppKit
import SwiftUI

enum SetupOnboardingStep: Int, CaseIterable, Sendable {
  case welcome = 1
  case explain = 2
  case agents = 3
  case progress = 4

  /// The step a fresh onboarding opens on. Naming it keeps the view's initial state from drifting
  /// away from the first case whenever a step is added ahead of the others.
  static let first = SetupOnboardingStep.welcome

  var marker: String {
    switch self {
    case .welcome: "1 OF 4"
    case .explain: "2 OF 4"
    case .agents: "3 OF 4"
    case .progress: "4 OF 4"
    }
  }
}

struct SetupTrustPoint: Identifiable, Equatable {
  let id: String
  let systemImage: String
  let text: String
}

enum SetupOnboardingCopy {
  static let welcomeName = PimpampumBrand.displayName
  static let welcomeTagline = "Project memory your agents can share."
  static let getStartedButton = "Get started"
  static let title = "Your agents share one project memory"
  static let detail =
    "Pimpampum keeps running in the background on this Mac. Your agents read and write the same projects, specs, and tasks instead of starting from scratch."
  static let changesTitle = "See exact changes"
  static let changesPending = "Working out the exact list…"
  static let agentsTitle = "Choose the agents you work in"
  static let agentsDetail =
    "You create and track work from your agents, not here. This menu shows the state they share."
  static let agentsListTitle = "Supported agents"
  static let progressReassurance =
    "You can close this menu. Setup continues and resumes here when you reopen it."
  static let progressTitle = "Setting up Pimpampum"
  static let serviceRowTitle = "Background service"
  static let continueButton = "Continue"
  static let finishButton = "Done"

  static let trustPoints = [
    SetupTrustPoint(
      id: "private",
      systemImage: "lock.shield",
      text: "Private to your macOS account"
    ),
    SetupTrustPoint(
      id: "availability",
      systemImage: "circle.dotted.circle",
      text: "Starts at sign-in and keeps running"
    ),
    SetupTrustPoint(
      id: "reversible",
      systemImage: "arrow.uturn.backward.circle",
      text: "Remove it anytime from Settings"
    ),
  ]
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
  /// Tall enough to hold the welcome and the explanation without either of them resizing the
  /// popover. Taller steps grow past it; the point is that the short ones do not shrink.
  static let stepMinimumHeight: CGFloat = 320

  @StateObject private var store: SetupStore
  let onFinished: () -> Void

  @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
  @State private var step: SetupOnboardingStep = SetupOnboardingStep.first
  @State private var isChangesHelpPresented = false

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
        // Help replaces the step inside the popover instead of opening a sheet. A sheet is a real
        // window, and a menu-bar popover closes as soon as it loses key focus, so presenting one
        // tore the whole setup down.
        if isChangesHelpPresented {
          SetupChangesHelpDialog(changes: store.plan?.changes ?? []) {
            isChangesHelpPresented = false
          }
        } else {
          stepHeader

          switch step {
          case .welcome: welcome
          case .explain: explanation
          case .agents: agentSelection
          case .progress: progressContent
          }
        }
      }
      // A common floor for every step. Without it the popover resizes as the user moves between
      // steps and the primary button slides out from under the pointer they were about to click.
      .frame(maxWidth: .infinity, minHeight: Self.stepMinimumHeight, alignment: .topLeading)
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
        .accessibilityLabel("Step \(step.rawValue) of \(SetupOnboardingStep.allCases.count)")

      // The welcome step carries its own centered lockup, so it must not repeat a leading title.
      if let stepTitle {
        Text(stepTitle)
          .font(.title2.weight(.semibold))
          .foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
      }
    }
  }

  private var stepTitle: String? {
    switch step {
    case .welcome: nil
    case .explain: SetupOnboardingCopy.title
    case .agents: SetupOnboardingCopy.agentsTitle
    case .progress: SetupOnboardingCopy.progressTitle
    }
  }

  private var welcome: some View {
    VStack(spacing: 14) {
      // The shared height floor leaves room to spare on this step. Split it above and below the
      // lockup instead of letting it all pile up underneath the button.
      Spacer(minLength: 0)

      PimpampumMark(size: 44)
        .foregroundStyle(.primary)
        .accessibilityHidden(true)

      VStack(spacing: 6) {
        Text(SetupOnboardingCopy.welcomeName)
          .font(.title2.weight(.semibold))
          .foregroundStyle(.primary)
          .accessibilityAddTraits(.isHeader)

        Text(SetupOnboardingCopy.welcomeTagline)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }

      Button(SetupOnboardingCopy.getStartedButton) { move(to: .explain) }
        .buttonStyle(GuidedPrimaryButtonStyle())
        .keyboardShortcut(.defaultAction)
        .accessibilityLabel("Get started with guided setup")

      Spacer(minLength: 0)
    }
    // A brand moment needs air, and the popover must still negotiate a visible height from the
    // menu bar's zero-height proposal. StatusPopoverTests pins that floor.
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.vertical, 24)
  }

  private var explanation: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(SetupOnboardingCopy.detail)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      VStack(alignment: .leading, spacing: 12) {
        ForEach(SetupOnboardingCopy.trustPoints) { point in
          trustRow(point.text, symbol: point.systemImage)
        }
      }

      Button(SetupOnboardingCopy.continueButton) { move(to: .agents) }
        .buttonStyle(GuidedPrimaryButtonStyle())
        .keyboardShortcut(.defaultAction)
        .accessibilityLabel("Continue to detected agents")
    }
  }

  private var agentSelection: some View {
    VStack(alignment: .leading, spacing: 14) {
      // Why a connection matters belongs to the step, not to the list header: Pimpampum has no
      // editing surface of its own, so the agent is where the work happens.
      Text(SetupOnboardingCopy.agentsDetail)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      Text(SetupOnboardingCopy.agentsListTitle)
        .font(.headline)

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
              // The label has to claim the row, or macOS sizes each Toggle to its own text and the
              // switches land at different x positions with the rows visibly ragged.
              VStack(alignment: .leading, spacing: 2) {
                Text(agent.id.displayName)
                  .foregroundStyle(.primary)
                Text(agent.detected ? "Detected on this Mac" : "Not detected")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
            .toggleStyle(.switch)
            .disabled(!agent.detected || store.busy)
            .frame(maxWidth: .infinity, minHeight: 44)
            .accessibilityLabel("Select \(agent.id.displayName)")
            .accessibilityValue(agent.selected ? "Selected" : "Not selected")
          }
        }
      }

      exactChangesLink
      // Planning is a read. Doing it here means the user confirms the operation they were shown,
      // instead of one computed after the button was already pressed.
      .task(id: store.selectedAgents) { await store.review() }

      if let errorMessage = store.errorMessage {
        inlineError(errorMessage)
      }

      HStack(spacing: 10) {
        Button("Back") { move(to: .explain) }
          .buttonStyle(GuidedSecondaryButtonStyle())
          .keyboardShortcut(.cancelAction)
          .accessibilityLabel("Back to what Pimpampum does")

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
      Text(SetupOnboardingCopy.progressReassurance)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      // The background service is machinery, not something the user chose, so it stays hidden while
      // it behaves. It still appears when it needs attention, and when no agent was selected, because
      // otherwise this step would report nothing at all.
      if store.service.state.needsAttention || store.agentResults.isEmpty {
        progressRow(
          title: SetupOnboardingCopy.serviceRowTitle,
          state: store.service.state,
          symbol: store.service.state.needsAttention ? "exclamationmark.triangle" : "gearshape"
        )
      }

      ForEach(store.agentResults) { agent in
        agentProgressRow(agent)
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
        Button(SetupOnboardingCopy.finishButton) {
          Task {
            // Hand the popover back before relaunching: on a copy started from Downloads that call
            // terminates this process.
            onFinished()
            await store.relaunchInstalledApplicationIfNeeded()
          }
        }
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
      // No detail line: `progressRow` already states the row's state, and "Not configured" showed
      // up while the agent was mid-connection, contradicting the row right above it.
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

  /// The plan the user is about to authorize stays one line. The spec still requires that the
  /// changes and their paths be inspectable before confirming, so the full list lives one click
  /// away rather than filling the step with something the user already chose above.
  private var exactChangesLink: some View {
    Group {
      if let changes = store.plan?.changes, !changes.isEmpty {
        Button {
          isChangesHelpPresented = true
        } label: {
          HStack(spacing: 5) {
            Image(systemName: "questionmark.circle")
            Text(SetupOnboardingCopy.changesTitle)
          }
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityLabel(SetupChangesHelpCopy.buttonTitle)
        .help(SetupChangesHelpCopy.buttonTitle)
      } else {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(SetupOnboardingCopy.changesPending)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(SetupOnboardingCopy.changesPending)
      }
    }
  }

  private func trustRow(_ title: String, symbol: String) -> some View {
    // These rows are read, never tapped. The 44pt floor is the tap target for the toggles and
    // buttons; applying it here only stretches the list to a 54pt stride and breaks its rhythm.
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        // One column width for three symbols of different advance, so every label starts at the
        // same x and the icons read as a set rather than three loose glyphs.
        .frame(width: 16, alignment: .center)

      Text(title)
        .font(.subheadline)
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
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
      // The plan is already on screen; re-planning here would apply a different operation than the
      // one the user reviewed.
      guard store.plan != nil, store.errorMessage == nil else { return }
      move(to: .progress)
      guard store.plan?.conflicts.isEmpty == true else { return }
      await store.apply()
      // The step reports the outcome and offers its own Done button. Closing setup is the user's
      // call: doing it here meant the result flashed past and the popover jumped to its normal
      // state before anyone could read what had happened.
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

struct GuidedPrimaryButtonStyle: ButtonStyle {
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
