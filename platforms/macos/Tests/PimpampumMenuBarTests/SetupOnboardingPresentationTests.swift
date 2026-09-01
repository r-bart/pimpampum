import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite("Guided setup presentation")
struct SetupOnboardingPresentationTests {
  private let connected = SetupAgentPresentation(
    id: .codex, state: .connected, configured: true, available: true, newSessionRequired: false,
    error: nil)

  @Test
  func titlesEveryStepButTheWelcome() {
    #expect(SetupOnboardingPresentation.stepTitle(for: .welcome) == nil)
    #expect(SetupOnboardingPresentation.stepTitle(for: .explain) == SetupOnboardingCopy.title)
    #expect(
      SetupOnboardingPresentation.stepTitle(for: .agents) == SetupOnboardingCopy.agentsTitle)
    #expect(
      SetupOnboardingPresentation.stepTitle(for: .progress) == SetupOnboardingCopy.progressTitle)
  }

  @Test
  func aFailedPlanIsShownInsteadOfAnEndlessSpinner() {
    #expect(SetupOnboardingPresentation.planRow(plan: nil, errorMessage: nil) == .pending)
    #expect(
      SetupOnboardingPresentation.planRow(plan: nil, errorMessage: "Boom") == .failed("Boom"))
    #expect(
      SetupOnboardingPresentation.planRow(plan: SetupFixtures.plan(), errorMessage: nil) == .ready)
    // An error after a plan still wins: the button is disabled and the reason is on screen.
    #expect(
      SetupOnboardingPresentation.planRow(plan: SetupFixtures.plan(), errorMessage: "Boom")
        == .failed("Boom"))
    #expect(SetupOnboardingPresentation.planRetryButton == "Try again")
    #expect(!SetupOnboardingPresentation.planRetryAccessibilityLabel.isEmpty)
  }

  @Test
  func theFinalStepTakesOverForMutationsProgressAndOutcomes() {
    #expect(
      !SetupOnboardingPresentation.showsDurableProgress(
        activity: .idle, progress: [], completion: nil))
    #expect(
      !SetupOnboardingPresentation.showsDurableProgress(
        activity: .planning, progress: [], completion: nil))
    #expect(
      SetupOnboardingPresentation.showsDurableProgress(
        activity: .applying, progress: [], completion: nil))
    #expect(
      SetupOnboardingPresentation.showsDurableProgress(
        activity: .resuming, progress: [], completion: nil))
    #expect(
      SetupOnboardingPresentation.showsDurableProgress(
        activity: .idle, progress: [SetupFixtures.event(phase: "service.install", status: .started)],
        completion: nil))
    #expect(
      SetupOnboardingPresentation.showsDurableProgress(
        activity: .idle, progress: [], completion: SetupFixtures.completeResult))
  }

  @Test
  func theServiceRowAppearsOnlyWhenItNeedsAttentionOrNothingElseWould() {
    let healthy = SetupServicePresentation(
      state: .connected, installed: true, running: true, verified: true)
    let broken = SetupServicePresentation(
      state: .unavailable, installed: true, running: false, verified: false)
    #expect(!SetupOnboardingPresentation.showsServiceRow(service: healthy, agentResults: [connected]))
    #expect(SetupOnboardingPresentation.showsServiceRow(service: healthy, agentResults: []))
    #expect(SetupOnboardingPresentation.showsServiceRow(service: broken, agentResults: [connected]))
    #expect(SetupOnboardingPresentation.serviceRowSymbol(healthy) == "gearshape")
    #expect(SetupOnboardingPresentation.serviceRowSymbol(broken) == "exclamationmark.triangle")
  }

  @Test
  func namesASetupAnotherProcessOwns() {
    #expect(SetupOnboardingPresentation.showsStillRunning(activity: .resuming))
    #expect(!SetupOnboardingPresentation.showsStillRunning(activity: .applying))
    #expect(!SetupOnboardingPresentation.showsStillRunning(activity: .idle))
    #expect(SetupOnboardingPresentation.stillRunningTitle == "Setup is still running")
    #expect(!SetupOnboardingPresentation.stillRunningDetail.isEmpty)
  }

  @Test
  func offersDoneForSuccessAndStartOverForAnyFinalOutcomeThatHasNoWayBack() {
    let complete = SetupFixtures.completeResult
    let failed = SetupFixtures.result(status: .failed, nextAction: .retry)
    let partial = SetupFixtures.result(status: .partial, nextAction: .retry)
    let conflict = SetupFixtures.result(status: .conflict, nextAction: .resolveConflict)
    #expect(SetupOnboardingPresentation.showsDone(completion: complete))
    #expect(!SetupOnboardingPresentation.showsDone(completion: failed))
    #expect(!SetupOnboardingPresentation.showsDone(completion: nil))

    #expect(SetupOnboardingPresentation.showsStartOver(activity: .idle, completion: complete))
    #expect(SetupOnboardingPresentation.showsStartOver(activity: .idle, completion: failed))
    // Partial has per-agent retry; conflict has its own decision block with a Cancel.
    #expect(!SetupOnboardingPresentation.showsStartOver(activity: .idle, completion: partial))
    #expect(!SetupOnboardingPresentation.showsStartOver(activity: .idle, completion: conflict))
    #expect(!SetupOnboardingPresentation.showsStartOver(activity: .idle, completion: nil))
    #expect(!SetupOnboardingPresentation.showsStartOver(activity: .applying, completion: failed))
    #expect(SetupOnboardingPresentation.startOverButton == "Start over")
    #expect(!SetupOnboardingPresentation.startOverAccessibilityLabel.isEmpty)
  }

  @Test
  func surfacesTheNextActionTheResultAsksFor() {
    let approval = SetupFixtures.result(status: .complete, nextAction: .recoverLoginItem)
    let newSession = SetupFixtures.result(status: .complete, nextAction: .newSession)
    #expect(SetupOnboardingPresentation.showsLoginItemApproval(completion: approval))
    #expect(!SetupOnboardingPresentation.showsLoginItemApproval(completion: newSession))
    #expect(SetupOnboardingPresentation.showsNewSessionAdvice(completion: newSession))
    #expect(!SetupOnboardingPresentation.showsNewSessionAdvice(completion: nil))
  }

  @Test
  func offersRetryForRepairsAndOpenForUsableAgents() {
    var agent = connected
    #expect(!SetupOnboardingPresentation.showsAgentRetry(agent))
    #expect(SetupOnboardingPresentation.showsOpenAgent(agent))
    agent.state = .newSessionRequired
    #expect(SetupOnboardingPresentation.showsOpenAgent(agent))
    agent.state = .needsRepair
    #expect(SetupOnboardingPresentation.showsAgentRetry(agent))
    #expect(!SetupOnboardingPresentation.showsOpenAgent(agent))
    agent.state = .connecting
    #expect(!SetupOnboardingPresentation.showsAgentRetry(agent))
    #expect(!SetupOnboardingPresentation.showsOpenAgent(agent))
  }

  @Test
  func opensOnlyARealApplicationDirectory() throws {
    let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
    #expect(
      SetupOnboardingPresentation.agentApplicationCandidates(for: .codex, homeDirectory: home)
        .map(\.path) == ["/Applications/Codex.app", "/Users/example/Applications/Codex.app"])
    #expect(
      SetupOnboardingPresentation.agentApplicationCandidates(for: .claudeCode, homeDirectory: home)
        .map(\.path) == ["/Applications/Claude.app", "/Users/example/Applications/Claude.app"])

    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-agent-app-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let real = root.appendingPathComponent("Real.app", isDirectory: true)
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    let link = root.appendingPathComponent("Link.app")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
    let missing = root.appendingPathComponent("Missing.app")
    #expect(
      SetupOnboardingPresentation.installedApplication(among: [missing, link, real])?.path
        == real.path)
    #expect(SetupOnboardingPresentation.installedApplication(among: [missing, link]) == nil)
  }
}
