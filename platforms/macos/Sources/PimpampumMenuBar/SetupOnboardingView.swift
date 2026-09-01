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

  /// Owned by the app. This view is one rendering of a session that outlives it.
  @ObservedObject var session: SetupSession

  @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
  @State private var isChangesHelpPresented = false

  private var store: SetupStore { session.store }
  private var step: SetupOnboardingStep { session.step }

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
    .onAppear { session.begin() }
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
      if let stepTitle = SetupOnboardingPresentation.stepTitle(for: step) {
        Text(stepTitle)
          .font(.title2.weight(.semibold))
          .foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
      }
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

      Button(SetupOnboardingCopy.getStartedButton) { session.move(to: .explain) }
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

      Button(SetupOnboardingCopy.continueButton) { session.move(to: .agents) }
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

      planRow
        // Planning is a read. Doing it here means the user confirms the operation they were shown,
        // instead of one computed after the button was already pressed.
        .task(id: store.selectedAgents) { await store.review() }

      HStack(spacing: 10) {
        Button("Back") { session.move(to: .explain) }
          .buttonStyle(GuidedSecondaryButtonStyle())
          .keyboardShortcut(.cancelAction)
          .accessibilityLabel("Back to what Pimpampum does")

        Button("Review & set up") { Task { await session.reviewAndSetUp() } }
          .buttonStyle(GuidedPrimaryButtonStyle())
          .keyboardShortcut(.defaultAction)
          .disabled(!store.canConfirm)
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

      if SetupOnboardingPresentation.showsStillRunning(activity: store.activity) {
        stillRunningNotice
      }

      if SetupOnboardingPresentation.showsServiceRow(
        service: store.service,
        agentResults: store.agentResults
      ) {
        progressRow(
          title: SetupOnboardingCopy.serviceRowTitle,
          state: store.service.state,
          symbol: SetupOnboardingPresentation.serviceRowSymbol(store.service)
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

      if SetupOnboardingPresentation.showsLoginItemApproval(completion: store.completion) {
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

      if SetupOnboardingPresentation.showsNewSessionAdvice(completion: store.completion) {
        Text(GuidedSetupRecoveryCopy.newSession)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if SetupOnboardingPresentation.showsDone(completion: store.completion) {
        Button(SetupOnboardingCopy.finishButton) {
          Task { await session.finish() }
        }
        .buttonStyle(GuidedPrimaryButtonStyle())
        .keyboardShortcut(.defaultAction)
        .accessibilityLabel("Finish setup")
      }

      if SetupOnboardingPresentation.showsStartOver(
        activity: store.activity,
        completion: store.completion
      ) {
        Button(SetupOnboardingPresentation.startOverButton) { session.startOver() }
          .buttonStyle(GuidedSecondaryButtonStyle())
          .accessibilityLabel(SetupOnboardingPresentation.startOverAccessibilityLabel)
      }
    }
  }

  /// Another process owns the running setup; this one follows its journal until it ends.
  private var stillRunningNotice: some View {
    HStack(alignment: .top, spacing: 10) {
      ProgressView().controlSize(.small)
      VStack(alignment: .leading, spacing: 2) {
        Text(SetupOnboardingPresentation.stillRunningTitle)
          .font(.subheadline.weight(.semibold))
        Text(SetupOnboardingPresentation.stillRunningDetail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(SetupOnboardingPresentation.stillRunningTitle)
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
      if SetupOnboardingPresentation.showsAgentRetry(agent) {
        Button(GuidedSetupRecoveryCopy.retry) {
          Task { await store.retry(agent.id) }
        }
        .buttonStyle(GuidedSecondaryButtonStyle())
        .disabled(store.busy)
        .accessibilityLabel("Try \(agent.id.displayName) again")
      }

      if SetupOnboardingPresentation.showsOpenAgent(agent) {
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

      Button("Cancel") { session.cancelConflictRecovery() }
        .buttonStyle(GuidedSecondaryButtonStyle())
        .keyboardShortcut(.cancelAction)
        .accessibilityLabel("Cancel setup without replacing configuration")
    }
    .padding(12)
    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  /// The plan the user is about to authorize stays one line. The spec still requires that the
  /// changes and their paths be inspectable before confirming, so the full list lives one click
  /// away rather than filling the step with something the user already chose above. A failed plan
  /// says so here, with a way to try again, instead of spinning under a disabled button.
  private var planRow: some View {
    Group {
      switch SetupOnboardingPresentation.planRow(
        plan: store.plan,
        errorMessage: store.errorMessage
      ) {
      case .ready:
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
      case .failed(let message):
        VStack(alignment: .leading, spacing: 8) {
          inlineError(message)
          Button(SetupOnboardingPresentation.planRetryButton) {
            Task { await store.review() }
          }
          .buttonStyle(GuidedSecondaryButtonStyle())
          .disabled(store.busy)
          .accessibilityLabel(SetupOnboardingPresentation.planRetryAccessibilityLabel)
        }
      case .pending:
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

  private func openAgent(_ id: SetupAgentID) {
    guard
      let application = SetupOnboardingPresentation.installedApplication(
        among: SetupOnboardingPresentation.agentApplicationCandidates(
          for: id,
          homeDirectory: FileManager.default.homeDirectoryForCurrentUser
        )
      )
    else { return }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.createsNewApplicationInstance = false
    NSWorkspace.shared.openApplication(at: application, configuration: configuration)
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
