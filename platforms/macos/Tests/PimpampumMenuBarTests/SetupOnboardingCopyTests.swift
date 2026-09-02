import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite
@MainActor
struct SetupOnboardingCopyTests {
  @Test
  func usesTheApprovedGuidedSetupCopy() {
    let expectedDetail = """
      Pimpampum keeps running in the background on this Mac. Your agents read and write the same \
      projects, specs, and tasks instead of starting from scratch.
      """
    #expect(SetupOnboardingCopy.title == "Your agents share one project memory")
    #expect(SetupOnboardingCopy.detail == expectedDetail)
    #expect(SetupOnboardingCopy.agentsTitle == "Choose the agents you work in")
    #expect(SetupOnboardingCopy.progressTitle == "Setting up Pimpampum")
    #expect(SetupOnboardingCopy.serviceRowTitle == "Background service")
    // "Private service" was internal vocabulary; nothing user-facing may reintroduce it.
    for text in [
      SetupOnboardingCopy.title, SetupOnboardingCopy.detail, SetupOnboardingCopy.agentsTitle,
      SetupOnboardingCopy.agentsDetail, SetupOnboardingCopy.progressTitle,
      SetupOnboardingCopy.serviceRowTitle, SetupOnboardingCopy.welcomeTagline,
    ] {
      #expect(!text.localizedCaseInsensitiveContains("private service"))
    }
    #expect(SetupOnboardingCopy.continueButton == "Continue")
    #expect(SetupOnboardingCopy.welcomeName == "pim • pam • pum")
    #expect(SetupOnboardingCopy.welcomeTagline == "Project memory your agents can share.")
    #expect(SetupOnboardingCopy.getStartedButton == "Get started")
  }

  @Test
  func statesEachTrustPointOnce() {
    #expect(
      SetupOnboardingCopy.trustPoints.map(\.text) == [
        "Private to your macOS account",
        "Starts at sign-in and keeps running",
        "Remove it anytime from Settings",
      ])
    #expect(
      Set(SetupOnboardingCopy.trustPoints.map(\.id)).count
        == SetupOnboardingCopy.trustPoints.count)
    #expect(SetupOnboardingCopy.trustPoints.allSatisfy { !$0.systemImage.isEmpty })
  }

  @Test
  func doesNotRepeatTheTrustPointsInsideTheDetailParagraph() {
    // The paragraph and the list used to say the same thing three times. Keep them disjoint.
    let detail = SetupOnboardingCopy.detail.lowercased()
    #expect(!detail.contains("sign-in"))
    #expect(!detail.contains("remove"))
    #expect(!detail.contains("private to"))
  }

  @Test
  func opensOnTheWelcomeStep() {
    // The view's initial state must track the first case. It kept pointing at `.explain` after the
    // welcome step was inserted ahead of it, which hid the new step entirely.
    #expect(SetupOnboardingStep.first == .welcome)
    #expect(SetupOnboardingStep.first == SetupOnboardingStep.allCases.first)
    #expect(SetupOnboardingStep.first.marker == "1 OF 4")
  }

  @Test
  func statesTheAgentListWithoutContradictingARow() {
    #expect(SetupOnboardingCopy.agentsListTitle == "Supported agents")
    // "Both" asserted a connector count the screen cannot guarantee: with one agent undetected it
    // was already wrong, and a third connector would break it again.
    #expect(!SetupOnboardingCopy.agentsDetail.localizedCaseInsensitiveContains("both"))
    // Principle 1 of the spec: connect agents, do not teach MCP.
    #expect(!SetupOnboardingCopy.agentsDetail.localizedCaseInsensitiveContains("mcp"))
    #expect(
      SetupOnboardingCopy.agentsDetail
        == "You create and track work from your agents, not here. "
          + "This menu shows the state they share.")
    // A row may read "Not detected", so the heading must not claim every row was detected.
    #expect(!SetupOnboardingCopy.agentsListTitle.localizedCaseInsensitiveContains("detected"))
  }

  @Test
  func namesTheConfirmationBlockWithoutProse() {
    // The block renders after the switches, so "below" sent the reader the wrong way.
    // The block no longer describes the changes in prose: it renders the plan the daemon returned,
    // so there is no hand-written summary left to drift out of date.
    #expect(SetupOnboardingCopy.changesTitle == "See exact changes")
    // The consent list is one click away, not a block on the step, but it must stay reachable:
    // the spec requires the planned paths to be inspectable before confirming.
    #expect(!SetupChangesHelpCopy.buttonTitle.isEmpty)
    #expect(SetupOnboardingCopy.changesPending == "Working out the exact list…")
  }

  @Test
  func reassuresWithoutAnUnverifiableAdverb() {
    #expect(
      SetupOnboardingCopy.progressReassurance
        == "You can close this menu. Setup continues and resumes here when you reopen it.")
    #expect(!SetupOnboardingCopy.progressReassurance.localizedCaseInsensitiveContains("safely"))
  }

  @Test
  func numbersTheFourGuidedSteps() {
    #expect(
      SetupOnboardingStep.allCases.map(\.marker) == ["1 OF 4", "2 OF 4", "3 OF 4", "4 OF 4"])
  }
}

/// Reads the bytes `pimpampum setup …` prints. `test/setup-envelope-shape.test.ts` regenerates the
/// same files from the real coordinator behind `runCli` and compares them, so a format change on
/// either end fails a test instead of reaching a user's first run.
@Suite
struct SetupEnvelopeFixtureTests {
  private var repositoryRoot: URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url
  }

  private func fixture(_ name: String) throws -> Data {
    try Data(
      contentsOf: repositoryRoot
        .appendingPathComponent("test/fixtures/setup")
        .appendingPathComponent("\(name).json")
    )
  }

  @Test("decodes the setup plan envelope the CLI prints, with its four disclosed changes")
  func decodesProducedPlanEnvelope() throws {
    let events = try SetupNDJSONDecoder.decode(try fixture("plan-envelope"))
    #expect(events.count == 1)
    guard case .plan(let plan) = events.last else {
      Issue.record("Expected one plan event")
      return
    }
    #expect(plan.requiresConfirmation)
    #expect(plan.operationId == "6c5bd965-8f55-455f-84f8-64aa3eb5693c")
    #expect(plan.revision.count == 64)
    #expect(plan.selectedConnectors.isEmpty)
    #expect(plan.conflicts.isEmpty)
    // The confirmation screen renders these rows verbatim: four changes, three of them with the
    // exact path they touch and the login item without one.
    #expect(plan.changes.count == 4)
    #expect(plan.changes.map(\.kind) == ["runtime", "service", "data", "login-item"])
    #expect(
      plan.changes.map(\.path) == [
        "/Users/example/Library/Application Support/Pimpampum/Runtime",
        "/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist",
        "/Users/example/.pimpampum",
        nil,
      ])
    #expect(plan.changes.allSatisfy { !$0.summary.isEmpty })
  }

  @Test("decodes the empty setup status envelope the CLI prints")
  func decodesProducedEmptyJournalEnvelope() throws {
    let events = try SetupNDJSONDecoder.decode(try fixture("empty-journal-envelope"))
    #expect(events.count == 1)
    guard case .journal(let journal) = events.last else {
      Issue.record("Expected one journal event")
      return
    }
    #expect(journal == nil)
  }
}

/// The consent list stays plain; the machinery lives in its help sheet. These freeze that split.
@Suite
@MainActor
struct SetupChangesHelpCopyTests {
  @Test
  func explainsEveryPlannedChangeWithoutJargon() {
    let kinds = ["runtime", "service", "data", "login-item", "connector:claude-code"]
    for kind in kinds {
      let detail = SetupChangesHelpCopy.detail(for: kind)
      #expect(!detail.isEmpty)
      // Plain language: no protocol names, no ports, no package managers.
      for jargon in ["MCP", "npm", "Node", "127.0.0.1", "daemon", "launchd", "plist", "CLI"] {
        #expect(!detail.contains(jargon))
      }
    }
  }

  @Test
  func namesEachAgentInItsOwnExplanation() {
    #expect(SetupChangesHelpCopy.detail(for: "connector:codex").contains("Codex"))
    #expect(SetupChangesHelpCopy.detail(for: "connector:claude-code").contains("Claude Code"))
  }

  @Test
  func fallsBackForAnUnknownChangeKind() {
    // A new change kind must still get an explanation rather than an empty row.
    #expect(!SetupChangesHelpCopy.detail(for: "something-new").isEmpty)
  }
}

@Suite
@MainActor
struct SetupChangesHelpDismissalTests {
  @Test("Done closes only the help sheet")
  func doneInvokesTheExplicitCallback() {
    // `@Environment(\.dismiss)` inside a menu-bar popover tore down the whole popover and threw the
    // user out of setup. Dismissal is now a callback the presenting view owns.
    var closed = 0
    let dialog = SetupChangesHelpDialog(
      changes: [SetupChange(kind: "runtime", summary: "Install it.", path: "/tmp/runtime")],
      onDone: { closed += 1 }
    )
    dialog.onDone()
    #expect(closed == 1)
    #expect(dialog.changes.count == 1)
  }
}
