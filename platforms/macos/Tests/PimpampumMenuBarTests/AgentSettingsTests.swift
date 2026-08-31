import Foundation
import Testing

@testable import PimpampumMenuBar

private actor AgentSettingsProcessFixture: SetupProcessRunning {
  var calls: [[String]] = []
  var cancellationModes: [Bool] = []

  func run(
    executable _: URL,
    arguments: [String],
    cancellationAllowed: Bool
  ) async throws -> SetupCommandOutput {
    calls.append(arguments)
    cancellationModes.append(cancellationAllowed)
    let command = Array(arguments.dropFirst())
    let json: String
    switch command {
    case ["status"]:
      json = #"{"data":{"installed":true,"running":true}}"#
    case ["connections"]:
      json =
        #"{"data":[{"id":"codex","displayName":"Codex","state":"ownedCurrent","available":true},{"id":"claude-code","displayName":"Claude Code","state":"notConnected","available":false}]}"#
    case ["connect", "--instructions"]:
      json =
        #"{"data":{"transport":"stdio","command":"/private/runtime/bin/pimpampum-mcp","arguments":[],"tokenIncluded":false,"connectors":[]}}"#
    default:
      json = #"{"data":{"changed":true}}"#
    }
    return SetupCommandOutput(
      exitCode: 0,
      standardOutput: Data(json.utf8),
      standardError: Data(),
      exceededLimit: false,
      cancelled: false
    )
  }
}

private actor AgentSettingsRunnerFixture: AgentConnectionCommandRunning {
  var mutationCalls: [(AgentSettingsAction, SetupAgentID)] = []
  var delayMutation = false

  func serviceStatus() async throws -> SetupServicePresentation {
    SetupServicePresentation(state: .connected, installed: true, running: true, verified: true)
  }

  func connections() async throws -> [AgentConnectionPresentation] {
    [
      AgentConnectionPresentation(id: .codex, ownershipState: "ownedCurrent", available: false),
      AgentConnectionPresentation(
        id: .claudeCode,
        ownershipState: "ownedStale",
        available: false
      ),
    ]
  }

  func advancedDetails() async throws -> AgentSettingsAdvancedDetails {
    AgentSettingsAdvancedDetails(
      launcherPath: "/private/runtime/bin/pimpampum-mcp",
      transport: "stdio",
      manualInstructions: "Use the built-in MCP settings."
    )
  }

  func connect(_ id: SetupAgentID) async throws {
    mutationCalls.append((.connect, id))
    if delayMutation { try await Task.sleep(for: .milliseconds(80)) }
  }

  func repair(_ id: SetupAgentID) async throws {
    mutationCalls.append((.repair, id))
    if delayMutation { try await Task.sleep(for: .milliseconds(80)) }
  }

  func disconnect(_ id: SetupAgentID) async throws {
    mutationCalls.append((.disconnect, id))
    if delayMutation { try await Task.sleep(for: .milliseconds(80)) }
  }

  func setDelayMutation(_ value: Bool) { delayMutation = value }
}

@MainActor
private struct AgentApplicationOpenerFixture: AgentApplicationOpening {
  let available: Set<SetupAgentID>
  func canOpen(_ id: SetupAgentID) -> Bool { available.contains(id) }
  func open(_ id: SetupAgentID) -> Bool { available.contains(id) }
}

@Suite("Agents settings")
struct AgentSettingsTests {
  @Test("maps ownership to state-valid and reversible actions")
  func validActions() {
    func actions(_ state: String, available: Bool = false, canOpen: Bool = false)
      -> [AgentSettingsAction]
    {
      AgentConnectionPresentation.validActions(
        for: AgentConnectionPresentation(
          id: .codex,
          ownershipState: state,
          available: available
        ),
        canOpen: canOpen
      )
    }

    #expect(actions("notInstalled").isEmpty)
    #expect(actions("unsupportedVersion").isEmpty)
    #expect(actions("notConnected") == [.connect])
    #expect(actions("ownedCurrent", available: true) == [.test, .disconnect])
    #expect(actions("ownedCurrent") == [.test, .repair, .disconnect])
    #expect(actions("ownedStale") == [.repair, .disconnect])
    #expect(actions("equivalentUnowned") == [.test])
    #expect(actions("conflict").isEmpty)
    #expect(actions("notConnected", canOpen: true) == [.connect, .open])
  }

  @Test("uses only the packaged executable and fixed argument arrays")
  func commandArguments() async throws {
    let process = AgentSettingsProcessFixture()
    let runtime = EmbeddedControlRuntime(
      rootURL: URL(fileURLWithPath: "/private/runtime"),
      executableURL: URL(fileURLWithPath: "/private/runtime/bin/node"),
      cliURL: URL(fileURLWithPath: "/private/runtime/dist/cli.js")
    )
    let runner = AgentConnectionCommandRunner(runtime: runtime, processRunner: process)

    #expect(try await runner.serviceStatus().verified)
    #expect(try await runner.connections().first?.state == .connected)
    #expect(try await runner.advancedDetails().transport == "stdio")
    try await runner.connect(.codex)
    try await runner.repair(.claudeCode)
    try await runner.disconnect(.codex)

    let cli = runtime.cliURL.path
    #expect(
      await process.calls == [
        [cli, "status"],
        [cli, "connections"],
        [cli, "connect", "--instructions"],
        [cli, "connect", "codex", "--yes"],
        [cli, "repair", "claude-code", "--yes"],
        [cli, "disconnect", "codex", "--yes"],
      ])
    #expect(await process.cancellationModes == [true, true, true, false, false, false])
  }

  @MainActor
  @Test("disconnects only the selected connector and preserves service presentation")
  func selectedDisconnect() async {
    let runner = AgentSettingsRunnerFixture()
    let store = AgentSettingsStore(
      runner: runner,
      applicationOpener: AgentApplicationOpenerFixture(available: [])
    )
    await store.load()
    await store.perform(.disconnect, for: .codex)

    #expect(store.service.verified)
    #expect(
      await runner.mutationCalls.map { "\($0.0.rawValue):\($0.1.rawValue)" } == [
        "Disconnect:codex"
      ])
  }

  @MainActor
  @Test("serializes competing agent mutations")
  func serializesMutations() async {
    let runner = AgentSettingsRunnerFixture()
    await runner.setDelayMutation(true)
    let store = AgentSettingsStore(
      runner: runner,
      applicationOpener: AgentApplicationOpenerFixture(available: [])
    )
    await store.load()

    let first = Task { await store.perform(.disconnect, for: .codex) }
    while store.busyAgent == nil { await Task.yield() }
    await store.perform(.repair, for: .claudeCode)
    await first.value

    #expect(await runner.mutationCalls.map(\.0) == [.disconnect])
  }
}
