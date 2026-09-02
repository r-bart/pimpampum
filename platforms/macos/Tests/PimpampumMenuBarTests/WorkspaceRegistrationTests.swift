import AppKit
import Foundation
import SwiftUI
import Testing

@testable import PimpampumMenuBar

/// D-01: a native install registers its first workspace from the app, through the packaged CLI's
/// `workspace:add`, so the README's first workflow never needs a terminal.
@Suite("Workspace registration request")
struct WorkspaceRegistrationRequestTests {
  @Test
  func buildsTheExactCliArgumentsFromTheChosenFolder() throws {
    let request = try #require(
      WorkspaceRegistrationRequest.forFolder(
        URL(fileURLWithPath: "/Users/example/Projects/Storefront", isDirectory: true)))
    #expect(request.id == "storefront")
    #expect(request.name == "Storefront")
    #expect(request.rootPath == "/Users/example/Projects/Storefront")
    #expect(
      request.arguments == ["workspace:add", "storefront", "Storefront", "/Users/example/Projects/Storefront"])
  }

  @Test(arguments: [
    ("Storefront", "storefront"),
    ("My  Work Folder", "my-work-folder"),
    ("Señor Ünïcode", "senor-unicode"),
    ("--leading and trailing--", "leading-and-trailing"),
    ("2026.09 release_notes", "2026-09-release-notes"),
    ("ALLCAPS", "allcaps"),
  ])
  func derivesALowercaseKebabCaseIdentifier(name: String, expected: String) {
    // The CLI's `slugSchema`: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, at most 80 characters.
    #expect(WorkspaceRegistrationRequest.identifier(from: name) == expected)
  }

  @Test
  func capsTheIdentifierAtEightyCharactersWithoutATrailingHyphen() {
    let long = String(repeating: "a", count: 100)
    #expect(WorkspaceRegistrationRequest.identifier(from: long) == String(repeating: "a", count: 80))
    // 79 letters, then a separator: "-x" would need 81 characters, so the identifier stops at 79.
    let boundary = String(repeating: "b", count: 79) + " x"
    #expect(WorkspaceRegistrationRequest.identifier(from: boundary) == String(repeating: "b", count: 79))
    let exact = String(repeating: "c", count: 78) + " x"
    #expect(WorkspaceRegistrationRequest.identifier(from: exact) == String(repeating: "c", count: 78) + "-x")
  }

  @Test
  func refusesAFolderThatCannotBecomeAWorkspace() {
    #expect(WorkspaceRegistrationRequest.identifier(from: "···") == nil)
    #expect(WorkspaceRegistrationRequest.identifier(from: "") == nil)
    #expect(WorkspaceRegistrationRequest.forFolder(URL(fileURLWithPath: "/", isDirectory: true)) == nil)
    #expect(WorkspaceRegistrationRequest.forFolder(URL(fileURLWithPath: "/Users/example/···")) == nil)
    // A relative URL never reaches the CLI; `workspace:add` demands an absolute root.
    #expect(WorkspaceRegistrationRequest.forFolder(URL(string: "relative/folder")!) == nil)
  }

  @Test
  func boundsAndCleansTheName() {
    #expect(WorkspaceRegistrationRequest.boundedName("  Store\u{7}front \n") == "Storefront")
    let long = String(repeating: "n", count: 200)
    #expect(WorkspaceRegistrationRequest.boundedName(long).count == 120)
    let request = WorkspaceRegistrationRequest.forFolder(
      URL(fileURLWithPath: "/Users/example/" + long, isDirectory: true))
    #expect(request?.name.count == 120)
    #expect(request?.id.count == 80)
  }
}

@Suite("Workspace registration decoder")
struct WorkspaceRegistrationDecoderTests {
  private let envelope = """
    {
      "data": {
        "id": "storefront",
        "name": "Storefront",
        "rootPath": "/Users/example/Projects/Storefront",
        "createdAt": "2026-09-01T10:00:00.000Z",
        "updatedAt": "2026-09-01T10:00:00.000Z"
      }
    }
    """

  @Test
  func acceptsTheIndentedEnvelopeAndABarePayload() throws {
    let expected = RegisteredWorkspace(
      id: "storefront", name: "Storefront", rootPath: "/Users/example/Projects/Storefront")
    #expect(try WorkspaceRegistrationDecoder.decode(Data(envelope.utf8)) == expected)
    let bare = #"{"id":"storefront","name":"Storefront","rootPath":"/Users/example/Projects/Storefront"}"#
    #expect(try WorkspaceRegistrationDecoder.decode(Data(bare.utf8)) == expected)
  }

  @Test(arguments: [
    "not json",
    "[]",
    #"{"data":[]}"#,
    #"{"data":{"id":"x","name":"X"}}"#,
    #"{"id":"x","name":"X","rootPath":"relative"}"#,
    #"{"id":"","name":"X","rootPath":"/x"}"#,
    #"{"id":"x","name":"X","rootPath":"/x\u0000"}"#,
    #"{"id":1,"name":"X","rootPath":"/x"}"#,
  ])
  func rejectsAnythingThatIsNotARegisteredWorkspace(text: String) {
    #expect(throws: SetupClientError.invalidResponse) {
      try WorkspaceRegistrationDecoder.decode(Data(text.utf8))
    }
  }

  @Test
  func boundsTheBuffer() {
    #expect(throws: SetupClientError.invalidResponse) {
      try WorkspaceRegistrationDecoder.decode(Data())
    }
    let padded = Data(repeating: 0x20, count: WorkspaceRegistrationDecoder.maximumBytes + 1)
    #expect(throws: SetupClientError.responseTooLarge) {
      try WorkspaceRegistrationDecoder.decode(padded)
    }
  }
}

@Suite("Workspace registration state and copy")
struct WorkspaceRegistrationStateTests {
  @Test
  func rendersOneNoticePerOutcomeAndNoneWhileIdle() {
    #expect(WorkspaceRegistrationState.idle.notice == nil)
    #expect(!WorkspaceRegistrationState.idle.isRegistering)
    let registering = WorkspaceRegistrationState.registering(folderName: "Storefront")
    #expect(registering.isRegistering)
    #expect(registering.notice?.inProgress == true)
    #expect(registering.notice?.text == "Adding “Storefront”…")
    let registered = WorkspaceRegistrationState.registered(SetupFixtures.registeredWorkspace)
    #expect(registered.notice?.text == "Workspace “Storefront” added.")
    #expect(registered.notice?.isFailure == false)
    #expect(registered.notice?.inProgress == false)
    let failed = WorkspaceRegistrationState.failed("Workspace already exists")
    #expect(failed.notice?.isFailure == true)
    #expect(failed.notice?.text == "Could not add the workspace. Workspace already exists")
    #expect(failed.notice?.symbol == "exclamationmark.triangle")
  }

  @Test
  func keepsTheCopyPlainAndSharedWithOmarchy() {
    #expect(WorkspaceRegistrationCopy.button == "Add a workspace")
    #expect(!WorkspaceRegistrationCopy.buttonAccessibilityLabel.isEmpty)
    // The two empty-state sentences are the ones StatusPopout.qml shows for the same cases.
    #expect(
      WorkspaceRegistrationCopy.emptyWorkspacesDetail
        == "Add a folder as a workspace to start tracking projects.")
    #expect(
      WorkspaceRegistrationCopy.emptyProjectsDetail
        == "Projects appear here as your agents create them.")
    for text in [
      WorkspaceRegistrationCopy.button, WorkspaceRegistrationCopy.onboardingDetail,
      WorkspaceRegistrationCopy.emptyWorkspacesDetail, WorkspaceRegistrationCopy.folderRejected,
    ] {
      for jargon in ["CLI", "Terminal", "npm", "MCP", "workspace:add"] {
        #expect(!text.contains(jargon))
      }
    }
  }
}

@Suite("Workspace registration surfaces")
@MainActor
struct WorkspaceRegistrationSurfaceTests {
  @Test
  func theFinalStepOffersTheActionOnlyOnceSetupCompleted() {
    #expect(SetupOnboardingPresentation.showsAddWorkspace(completion: SetupFixtures.completeResult))
    #expect(
      !SetupOnboardingPresentation.showsAddWorkspace(
        completion: SetupFixtures.result(status: .failed, nextAction: .retry)))
    #expect(!SetupOnboardingPresentation.showsAddWorkspace(completion: nil))
  }

  @Test
  func theOverviewOffersTheActionOnlyWithoutAWorkspace() {
    let empty = testOverview(status: .empty)
    #expect(empty.counts.workspaces == 0)
    #expect(StatusPopover.showsAddWorkspace(overview: empty))
    #expect(
      StatusPopover.emptyProjectsDetail(overview: empty)
        == WorkspaceRegistrationCopy.emptyWorkspacesDetail)
    let withWorkspace = testOverview(
      status: .active, projects: [testProject(id: "p", status: .active, updatedAt: Date())])
    #expect(withWorkspace.counts.workspaces > 0)
    #expect(!StatusPopover.showsAddWorkspace(overview: withWorkspace))
    #expect(
      StatusPopover.emptyProjectsDetail(overview: withWorkspace)
        == WorkspaceRegistrationCopy.emptyProjectsDetail)
    #expect(!StatusPopover.showsAddWorkspace(overview: nil))
  }

  @Test
  func bothSurfacesComposeWithAnInjectedFolderPicker() {
    let picker = WorkspaceFolderPicker { _ in URL(fileURLWithPath: "/Users/example/Work") }
    #expect(picker.chooseDirectory(initialDirectory: nil)?.path == "/Users/example/Work")
    #expect(WorkspaceFolderPicker { _ in nil }.chooseDirectory(initialDirectory: nil) == nil)
    let session = SetupSession(store: SetupStore(runner: UnavailableSetupCommandRunner()))
    _ = SetupOnboardingView(session: session, workspaceFolderPicker: picker).body
    let store = OverviewStore(reader: StaticEmptyOverviewReader())
    _ = StatusPopover(store: store, setupSession: session, workspaceFolderPicker: picker).body
    _ = WorkspaceRegistrationNoticeRow(
      notice: WorkspaceRegistrationState.registering(folderName: "Work").notice!
    ).body
    _ = WorkspaceRegistrationNoticeRow(
      notice: WorkspaceRegistrationState.failed("Boom").notice!
    ).body
  }

  @Test
  func theUnavailableRunnerRefusesToRegister() async {
    let runner = UnavailableSetupCommandRunner()
    await #expect(throws: SetupClientError.unavailable) {
      try await runner.registerWorkspace(
        WorkspaceRegistrationRequest(id: "x", name: "X", rootPath: "/x"))
    }
  }
}

private struct StaticEmptyOverviewReader: OverviewReading {
  func fetchOverview() async throws -> Overview { testOverview(status: .empty) }
}

/// The session owns the registration so the final step and the overview share one outcome.
@Suite("Setup session workspace registration")
@MainActor
struct SetupSessionWorkspaceTests {
  private func session(
    runner: ScriptedSetupRunner = ScriptedSetupRunner(),
    overviewStore: OverviewStore? = nil
  ) -> SetupSession {
    SetupSession(
      store: SetupStore(
        runner: runner,
        detector: StubAgentDetector(detected: [.codex]),
        clock: ImmediateSetupClock()
      ),
      overviewStore: overviewStore
    )
  }

  @Test
  func registersTheChosenFolderThroughTheCliAndRefreshesTheOverview() async {
    let reader = SequenceOverviewReader(Array(repeating: .success(testOverview()), count: 4))
    let overview = OverviewStore(reader: reader, clock: RecordingOverviewClock(date: Date()))
    let runner = ScriptedSetupRunner()
    let session = session(runner: runner, overviewStore: overview)
    let before = await reader.callCount

    await session.addWorkspace(
      at: URL(fileURLWithPath: "/Users/example/Projects/Storefront", isDirectory: true))

    #expect(
      session.workspaceRegistration == .registered(SetupFixtures.registeredWorkspace))
    #expect(
      await runner.workspaceCalls == [
        WorkspaceRegistrationRequest(
          id: "storefront", name: "Storefront", rootPath: "/Users/example/Projects/Storefront")
      ])
    #expect(await reader.callCount == before + 1)
  }

  @Test
  func showsTheDaemonsRefusalAndAnyOtherFailureSanitized() async {
    let runner = ScriptedSetupRunner()
    await runner.setWorkspaceResult(
      .failure(SetupClientError.commandFailed("Workspace already exists at /Users/example/x")))
    let session = session(runner: runner)
    await session.addWorkspace(at: URL(fileURLWithPath: "/Users/example/x", isDirectory: true))
    #expect(session.workspaceRegistration == .failed("Workspace already exists at ~/x"))

    await runner.setWorkspaceResult(.failure(SetupTestError()))
    await session.addWorkspace(at: URL(fileURLWithPath: "/Users/example/y", isDirectory: true))
    guard case .failed(let message) = session.workspaceRegistration else {
      Issue.record("Expected a failure")
      return
    }
    #expect(!message.isEmpty)
  }

  @Test
  func refusesAFolderWithoutAUsableNameBeforeCallingTheCli() async {
    let runner = ScriptedSetupRunner()
    let session = session(runner: runner)
    await session.addWorkspace(at: URL(fileURLWithPath: "/", isDirectory: true))
    #expect(session.workspaceRegistration == .failed(WorkspaceRegistrationCopy.folderRejected))
    #expect(await runner.workspaceCalls.isEmpty)
  }

  @Test
  func ignoresASecondRequestWhileOneIsInFlight() async {
    let runner = ScriptedSetupRunner()
    let gate = SetupGate()
    await runner.setWorkspaceGate(gate)
    let session = session(runner: runner)
    let first = Task {
      await session.addWorkspace(at: URL(fileURLWithPath: "/Users/example/a", isDirectory: true))
    }
    #expect(
      await eventually { await MainActor.run { session.workspaceRegistration.isRegistering } })
    await session.addWorkspace(at: URL(fileURLWithPath: "/Users/example/b", isDirectory: true))
    await session.addWorkspace(using: WorkspaceFolderPicker { _ in URL(fileURLWithPath: "/c") })
    await gate.open()
    await first.value
    #expect(await runner.workspaceCalls.map(\.id) == ["a"])
  }

  @Test
  func aCancelledPickerChangesNothingAndAChoiceRegisters() async {
    let runner = ScriptedSetupRunner()
    let session = session(runner: runner)
    await session.addWorkspace(using: WorkspaceFolderPicker { _ in nil })
    #expect(session.workspaceRegistration == .idle)
    #expect(await runner.workspaceCalls.isEmpty)

    await session.addWorkspace(
      using: WorkspaceFolderPicker { _ in
        URL(fileURLWithPath: "/Users/example/Projects/Storefront", isDirectory: true)
      })
    #expect(session.workspaceRegistration == .registered(SetupFixtures.registeredWorkspace))
  }

  @Test
  func doneAndStartOverClearTheOutcome() async {
    let runner = ScriptedSetupRunner()
    let session = session(runner: runner)
    await session.addWorkspace(
      at: URL(fileURLWithPath: "/Users/example/Projects/Storefront", isDirectory: true))
    #expect(session.workspaceRegistration != .idle)
    session.startOver()
    #expect(session.workspaceRegistration == .idle)

    await session.addWorkspace(
      at: URL(fileURLWithPath: "/Users/example/Projects/Storefront", isDirectory: true))
    await session.finish()
    #expect(session.workspaceRegistration == .idle)
  }
}
