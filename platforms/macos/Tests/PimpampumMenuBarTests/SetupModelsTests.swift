import Testing

@testable import PimpampumMenuBar

/// `SetupModels` decides what the guided setup shows and when it may mutate. Two of this session's
/// defects lived here — `hasBegunMutation` sent the onboarding to its final step, and the missing
/// `needsAttention` left that step blank — while the coverage gate excluded the file entirely.
@Suite("Setup presentation models")
struct SetupModelsTests {
  @Test("agent identifiers keep their wire values and display names")
  func agentIdentifiers() {
    #expect(SetupAgentID.codex.rawValue == "codex")
    #expect(SetupAgentID.claudeCode.rawValue == "claude-code")
    #expect(SetupAgentID.codex.displayName == "Codex")
    #expect(SetupAgentID.claudeCode.displayName == "Claude Code")
    #expect(SetupAgentID.allCases.count == 2)
  }

  @Test("only a detected and supported agent is selected by default")
  func defaultSelection() {
    func selection(detected: Bool, supported: Bool) -> SetupAgentSelection {
      SetupAgentSelection(id: .codex, detected: detected, supported: supported, selected: false)
    }
    #expect(selection(detected: true, supported: true).selectedByDefault)
    #expect(!selection(detected: false, supported: true).selectedByDefault)
    #expect(!selection(detected: true, supported: false).selectedByDefault)
    #expect(!selection(detected: false, supported: false).selectedByDefault)
  }

  @Test("every component state has a label, and accessibility reads the same one")
  func componentStateLabels() {
    let expected: [SetupComponentState: String] = [
      .notInstalled: "Not installed",
      .notConnected: "Not connected",
      .connecting: "Connecting",
      .connected: "Connected",
      .newSessionRequired: "New session required",
      .needsRepair: "Needs repair",
      .configurationConflict: "Configuration conflict",
      .unsupportedVersion: "Unsupported version",
      .unavailable: "Unavailable",
    ]
    for (state, label) in expected {
      #expect(state.label == label)
      #expect(state.accessibilityLabel == label)
    }
  }

  @Test("a healthy component never asks for attention and a broken one always does")
  func componentStateAttention() {
    // The setup step hides the background service unless this is true, so a state landing on the
    // wrong side either nags the user or hides a real failure.
    for healthy: SetupComponentState in [.connected, .connecting, .newSessionRequired] {
      #expect(!healthy.needsAttention)
    }
    for broken: SetupComponentState in [
      .notInstalled, .notConnected, .needsRepair, .configurationConflict, .unsupportedVersion,
      .unavailable,
    ] {
      #expect(broken.needsAttention)
    }
  }

  @Test("activity separates busy from mutating")
  func activityFlags() {
    #expect(!SetupActivity.idle.isBusy)
    #expect(!SetupActivity.idle.hasBegunMutation)
    // Detecting and planning are reads: they must never look like a mutation, because the
    // onboarding jumps to its final step on that flag and never comes back.
    for reading: SetupActivity in [.detecting, .planning] {
      #expect(reading.isBusy)
      #expect(!reading.hasBegunMutation)
    }
    for mutating: SetupActivity in [.applying, .resuming] {
      #expect(mutating.isBusy)
      #expect(mutating.hasBegunMutation)
    }
  }

  @Test("wire values of every coded enum stay stable")
  func codedRawValues() {
    #expect(SetupProgressStatus.started.rawValue == "started")
    #expect(SetupProgressStatus.completed.rawValue == "completed")
    #expect(SetupProgressStatus.failed.rawValue == "failed")
    #expect(SetupCompletionStatus.complete.rawValue == "complete")
    #expect(SetupCompletionStatus.partial.rawValue == "partial")
    #expect(SetupCompletionStatus.conflict.rawValue == "conflict")
    #expect(SetupCompletionStatus.failed.rawValue == "failed")
    #expect(SetupNextAction.done.rawValue == "done")
    #expect(SetupNextAction.retry.rawValue == "retry")
    #expect(SetupNextAction.newSession.rawValue == "new-session")
    #expect(SetupNextAction.resolveConflict.rawValue == "resolve-conflict")
    #expect(SetupNextAction.recoverLoginItem.rawValue == "recover-login-item")
    for status in [
      SetupJournalStatus.running, .complete, .partial, .conflict, .failed,
    ] {
      #expect(!status.rawValue.isEmpty)
    }
  }

  @Test("conflict decisions and wire events compare by value")
  func valueSemantics() {
    #expect(SetupConflictDecision.keep == .keep)
    #expect(SetupConflictDecision.keep != .replace)
    #expect(SetupWireEvent.journal(nil) == .journal(nil))

    let change = SetupChange(kind: "runtime", summary: "Install it.", path: "/tmp/runtime")
    #expect(change == SetupChange(kind: "runtime", summary: "Install it.", path: "/tmp/runtime"))
    #expect(change != SetupChange(kind: "runtime", summary: "Install it.", path: nil))

    let conflict = SetupConflict(connectorId: .codex, comparison: "differs")
    #expect(conflict != SetupConflict(connectorId: .claudeCode, comparison: "differs"))
  }

  @Test("every client error carries a message")
  func clientErrorMessages() {
    let errors: [SetupClientError] = [
      .unavailable, .invalidResponse, .incompatibleSchema, .responseTooLarge,
      .commandFailed("boom"), .cancelled,
    ]
    for error in errors {
      #expect(!error.message.isEmpty)
    }
    #expect(SetupClientError.commandFailed("boom").message.contains("boom"))
    #expect(SetupClientError.commandFailed("boom") != SetupClientError.commandFailed("other"))
  }
}
