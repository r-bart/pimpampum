import Foundation

/// What the agents step shows where the planned changes go: a link to the exact list, the reason
/// planning failed, or the wait while the plan is computed.
enum SetupPlanRowState: Equatable, Sendable {
  case pending
  case failed(String)
  case ready
}

/// Every decision the guided setup screens make, kept out of the SwiftUI bodies so the coverage
/// gate measures it.
enum SetupOnboardingPresentation {
  static let stillRunningTitle = "Setup is still running"
  static let stillRunningDetail =
    "Another copy of Pimpampum is finishing this setup. The result appears here when it is done."
  static let startOverButton = "Start over"
  static let startOverAccessibilityLabel = "Start setup over from the first step"
  static let planRetryButton = "Try again"
  static let planRetryAccessibilityLabel = "Try working out the exact list again"

  /// Whether one segment of the step bar is filled at the current step. Every step at or before
  /// the current one is filled, so the bar reads as progress rather than as a cursor.
  static func isSegmentFilled(_ segment: SetupOnboardingStep, at step: SetupOnboardingStep) -> Bool
  {
    segment.rawValue <= step.rawValue
  }

  /// What assistive technology reads instead of the bar. The bar replaced a "1 OF 4" label, and
  /// that sentence is the only place the count is still spelled out.
  static func progressLabel(for step: SetupOnboardingStep) -> String {
    "Step \(step.rawValue) of \(SetupOnboardingStep.allCases.count)"
  }

  static func stepTitle(for step: SetupOnboardingStep) -> String? {
    switch step {
    case .welcome: nil
    case .explain: SetupOnboardingCopy.title
    case .agents: SetupOnboardingCopy.agentsTitle
    case .progress: SetupOnboardingCopy.progressTitle
    }
  }

  /// A failed plan used to leave the spinner turning forever under an enabled button that did
  /// nothing. The failure is shown, with a way to plan again.
  static func planRow(plan: SetupPlan?, errorMessage: String?) -> SetupPlanRowState {
    if let errorMessage { return .failed(errorMessage) }
    if plan != nil { return .ready }
    return .pending
  }

  /// The final step takes over as soon as a mutation has begun or an outcome exists, whether this
  /// process started it or a durable journal reports it.
  static func showsDurableProgress(
    activity: SetupActivity,
    progress: [SetupProgressEvent],
    completion: SetupResult?
  ) -> Bool {
    activity.hasBegunMutation || !progress.isEmpty || completion != nil
  }

  /// The background service is machinery, not something the user chose, so it stays hidden while
  /// it behaves. It still appears when it needs attention, and when no agent was selected, because
  /// otherwise the step would report nothing at all.
  static func showsServiceRow(
    service: SetupServicePresentation,
    agentResults: [SetupAgentPresentation]
  ) -> Bool {
    service.state.needsAttention || agentResults.isEmpty
  }

  static func serviceRowSymbol(_ service: SetupServicePresentation) -> String {
    service.state.needsAttention ? "exclamationmark.triangle" : "gearshape"
  }

  /// Another process holds the setup and this one only watches its journal.
  static func showsStillRunning(activity: SetupActivity) -> Bool {
    activity == .resuming
  }

  static func showsDone(completion: SetupResult?) -> Bool {
    completion?.status == .complete
  }

  /// The first workspace is registered right before Done, so a user who followed only the app
  /// never needs a terminal for the overview to show anything. A setup that did not complete has
  /// no daemon to register it with.
  static func showsAddWorkspace(completion: SetupResult?) -> Bool {
    showsDone(completion: completion)
  }

  /// A finished or failed setup has no Back button; this is the way back to the first step, to run
  /// setup again with another selection or after fixing the cause.
  static func showsStartOver(activity: SetupActivity, completion: SetupResult?) -> Bool {
    guard !activity.hasBegunMutation, let status = completion?.status else { return false }
    return status == .failed || status == .complete
  }

  static func showsLoginItemApproval(completion: SetupResult?) -> Bool {
    completion?.nextAction == .recoverLoginItem
  }

  static func showsNewSessionAdvice(completion: SetupResult?) -> Bool {
    completion?.nextAction == .newSession
  }

  static func showsAgentRetry(_ agent: SetupAgentPresentation) -> Bool {
    agent.state == .needsRepair
  }

  static func showsOpenAgent(_ agent: SetupAgentPresentation) -> Bool {
    agent.state == .connected || agent.state == .newSessionRequired
  }

  static func agentApplicationCandidates(for id: SetupAgentID, homeDirectory: URL) -> [URL] {
    let name =
      switch id {
      case .codex: "Codex.app"
      case .claudeCode: "Claude.app"
      }
    return [
      URL(fileURLWithPath: "/Applications/\(name)", isDirectory: true),
      homeDirectory.appendingPathComponent("Applications/\(name)", isDirectory: true),
    ]
  }

  /// The first candidate that is a real application directory. A symlink is not trusted, because
  /// it could point the open request anywhere.
  static func installedApplication(among candidates: [URL]) -> URL? {
    candidates.first { candidate in
      guard
        let values = try? candidate.resourceValues(forKeys: [
          .isDirectoryKey, .isSymbolicLinkKey,
        ])
      else { return false }
      return values.isDirectory == true && values.isSymbolicLink != true
    }
  }
}
