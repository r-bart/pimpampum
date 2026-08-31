import AppKit
import Combine
import Foundation
import SwiftUI

enum AgentSettingsAction: String, CaseIterable, Equatable, Sendable {
  case connect = "Connect"
  case test = "Test"
  case repair = "Repair"
  case open = "Open"
  case disconnect = "Disconnect"

  var mutatesHost: Bool { self == .connect || self == .repair || self == .disconnect }
}

struct AgentConnectionPresentation: Identifiable, Equatable, Sendable {
  let id: SetupAgentID
  let ownershipState: String
  let available: Bool

  var state: SetupComponentState {
    switch ownershipState {
    case "notInstalled": .notInstalled
    case "unsupportedVersion": .unsupportedVersion
    case "notConnected": .notConnected
    case "ownedCurrent": available ? .connected : .needsRepair
    case "ownedStale": .needsRepair
    case "equivalentUnowned": available ? .connected : .unavailable
    case "conflict": .configurationConflict
    default: .unavailable
    }
  }

  var stateLabel: String {
    switch state {
    case .notInstalled: "Not installed"
    case .notConnected: "Not connected"
    case .connecting: "Connecting"
    case .connected: "Connected"
    case .newSessionRequired: "New session required"
    case .needsRepair: "Needs repair"
    case .configurationConflict: "Configuration conflict"
    case .unsupportedVersion: "Unsupported version"
    case .unavailable: "Unavailable"
    }
  }

  static func validActions(
    for connection: AgentConnectionPresentation,
    canOpen: Bool
  ) -> [AgentSettingsAction] {
    var actions: [AgentSettingsAction]
    switch connection.ownershipState {
    case "notConnected": actions = [.connect]
    case "ownedCurrent":
      actions = connection.available ? [.test, .disconnect] : [.test, .repair, .disconnect]
    case "ownedStale": actions = [.repair, .disconnect]
    case "equivalentUnowned": actions = [.test]
    case "unsupportedVersion": actions = []
    case "notInstalled", "conflict": actions = []
    default: actions = []
    }
    if canOpen { actions.insert(.open, at: min(1, actions.count)) }
    return actions
  }
}

struct AgentSettingsAdvancedDetails: Equatable, Sendable {
  let launcherPath: String
  let transport: String
  let manualInstructions: String
}

protocol AgentConnectionCommandRunning: Sendable {
  func serviceStatus() async throws -> SetupServicePresentation
  func connections() async throws -> [AgentConnectionPresentation]
  func advancedDetails() async throws -> AgentSettingsAdvancedDetails
  func connect(_ id: SetupAgentID) async throws
  func repair(_ id: SetupAgentID) async throws
  func disconnect(_ id: SetupAgentID) async throws
}

struct AgentConnectionCommandRunner: AgentConnectionCommandRunning {
  private let runtime: EmbeddedControlRuntime
  private let processRunner: any SetupProcessRunning

  init(
    runtime: EmbeddedControlRuntime,
    processRunner: any SetupProcessRunning = LocalSetupProcessRunner()
  ) {
    self.runtime = runtime
    self.processRunner = processRunner
  }

  func serviceStatus() async throws -> SetupServicePresentation {
    let envelope: Envelope<ServicePayload> = try await request(["status"])
    let state: SetupComponentState =
      envelope.data.running
      ? .connected : envelope.data.installed ? .unavailable : .notInstalled
    return SetupServicePresentation(
      state: state,
      installed: envelope.data.installed,
      running: envelope.data.running,
      verified: envelope.data.running
    )
  }

  func connections() async throws -> [AgentConnectionPresentation] {
    let envelope: Envelope<[ConnectionPayload]> = try await request(["connections"])
    guard envelope.data.count <= SetupAgentID.allCases.count else {
      throw SetupClientError.invalidResponse
    }
    var seen = Set<SetupAgentID>()
    let values = try envelope.data.map { payload in
      guard let id = SetupAgentID(rawValue: payload.id),
        Self.allowedOwnershipStates.contains(payload.state),
        seen.insert(id).inserted
      else { throw SetupClientError.invalidResponse }
      return AgentConnectionPresentation(
        id: id,
        ownershipState: payload.state,
        available: payload.available
      )
    }
    return SetupAgentID.allCases.map { id in
      values.first(where: { $0.id == id })
        ?? AgentConnectionPresentation(id: id, ownershipState: "unavailable", available: false)
    }
  }

  func advancedDetails() async throws -> AgentSettingsAdvancedDetails {
    let envelope: Envelope<InstructionsPayload> = try await request(["connect", "--instructions"])
    let path = envelope.data.command
    guard envelope.data.transport == "stdio",
      path.hasPrefix("/"), path.count <= 1_024, !path.contains("\0"),
      envelope.data.arguments.isEmpty
    else { throw SetupClientError.invalidResponse }
    return AgentSettingsAdvancedDetails(
      launcherPath: path,
      transport: envelope.data.transport,
      manualInstructions:
        "In the agent's MCP settings, add a server named pimpampum with this launcher and no arguments."
    )
  }

  func connect(_ id: SetupAgentID) async throws {
    try await mutation(["connect", id.rawValue, "--yes"])
  }

  func repair(_ id: SetupAgentID) async throws {
    try await mutation(["repair", id.rawValue, "--yes"])
  }

  func disconnect(_ id: SetupAgentID) async throws {
    try await mutation(["disconnect", id.rawValue, "--yes"])
  }

  private func mutation(_ arguments: [String]) async throws {
    // Once a confirmed host transaction starts, let the packaged CLI finish its own rollback.
    let output = try await run(arguments, cancellationAllowed: false)
    guard let object = try? JSONSerialization.jsonObject(with: output),
      let envelope = object as? [String: Any], envelope["data"] is [String: Any]
    else { throw SetupClientError.invalidResponse }
  }

  private func request<Value: Decodable>(_ arguments: [String]) async throws -> Envelope<Value> {
    let output = try await run(arguments, cancellationAllowed: true)
    guard let envelope = try? JSONDecoder().decode(Envelope<Value>.self, from: output) else {
      throw SetupClientError.invalidResponse
    }
    return envelope
  }

  private func run(_ arguments: [String], cancellationAllowed: Bool) async throws -> Data {
    let invocation = runtime.invocation(arguments: arguments)
    let output: SetupCommandOutput
    if cancellationAllowed {
      output = try await withThrowingTaskGroup(of: SetupCommandOutput.self) { group in
        group.addTask {
          try await processRunner.run(
            executable: invocation.executableURL,
            arguments: invocation.arguments,
            cancellationAllowed: true
          )
        }
        group.addTask {
          try await Task.sleep(for: .seconds(20))
          throw SetupClientError.commandFailed(
            "The packaged connection check took too long and was stopped."
          )
        }
        guard let first = try await group.next() else { throw SetupClientError.invalidResponse }
        group.cancelAll()
        return first
      }
    } else {
      output = try await processRunner.run(
        executable: invocation.executableURL,
        arguments: invocation.arguments,
        cancellationAllowed: false
      )
    }
    if output.cancelled { throw SetupClientError.cancelled }
    if output.exceededLimit { throw SetupClientError.responseTooLarge }
    guard output.exitCode == 0 else {
      throw SetupClientError.commandFailed(Self.failureMessage(output.standardError))
    }
    guard !output.standardOutput.isEmpty else { throw SetupClientError.invalidResponse }
    return output.standardOutput
  }

  private struct Envelope<Value: Decodable>: Decodable { let data: Value }
  private struct ServicePayload: Decodable {
    let installed: Bool
    let running: Bool
  }
  private struct ConnectionPayload: Decodable {
    let id: String
    let state: String
    let available: Bool
  }
  private struct InstructionsPayload: Decodable {
    let transport: String
    let command: String
    let arguments: [String]
  }
  private struct FailureEnvelope: Decodable {
    struct Failure: Decodable { let message: String }
    let error: Failure
  }

  private static let allowedOwnershipStates: Set<String> = [
    "notInstalled", "unsupportedVersion", "notConnected", "ownedCurrent", "ownedStale",
    "equivalentUnowned", "conflict", "unavailable",
  ]

  private static func failureMessage(_ data: Data) -> String {
    guard let envelope = try? JSONDecoder().decode(FailureEnvelope.self, from: data) else {
      return "The packaged connection command failed. Retry from Pimpampum."
    }
    return SetupStore.sanitize(envelope.error.message)
  }
}

@MainActor
protocol AgentApplicationOpening {
  func canOpen(_ id: SetupAgentID) -> Bool
  func open(_ id: SetupAgentID) -> Bool
}

@MainActor
struct LocalAgentApplicationOpener: AgentApplicationOpening {
  private let homeDirectory: URL

  init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) {
    self.homeDirectory = homeDirectory
  }

  func canOpen(_ id: SetupAgentID) -> Bool { applicationURL(for: id) != nil }

  func open(_ id: SetupAgentID) -> Bool {
    guard let url = applicationURL(for: id) else { return false }
    return NSWorkspace.shared.open(url)
  }

  private func applicationURL(for id: SetupAgentID) -> URL? {
    let name = id == .codex ? "Codex.app" : "Claude.app"
    return [
      URL(fileURLWithPath: "/Applications").appendingPathComponent(name, isDirectory: true),
      homeDirectory.appendingPathComponent("Applications", isDirectory: true)
        .appendingPathComponent(name, isDirectory: true),
    ].first(where: Self.regularApplication)
  }

  private static func regularApplication(_ url: URL) -> Bool {
    guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    else {
      return false
    }
    return values.isDirectory == true && values.isSymbolicLink != true
  }
}

private struct UnavailableAgentConnectionRunner: AgentConnectionCommandRunning {
  func serviceStatus() async throws -> SetupServicePresentation {
    throw SetupClientError.unavailable
  }
  func connections() async throws -> [AgentConnectionPresentation] {
    throw SetupClientError.unavailable
  }
  func advancedDetails() async throws -> AgentSettingsAdvancedDetails {
    throw SetupClientError.unavailable
  }
  func connect(_ id: SetupAgentID) async throws { throw SetupClientError.unavailable }
  func repair(_ id: SetupAgentID) async throws { throw SetupClientError.unavailable }
  func disconnect(_ id: SetupAgentID) async throws { throw SetupClientError.unavailable }
}

@MainActor
final class AgentSettingsStore: ObservableObject {
  @Published private(set) var service = SetupServicePresentation(
    state: .unavailable,
    installed: false,
    running: false,
    verified: false
  )
  @Published private(set) var connections = SetupAgentID.allCases.map {
    AgentConnectionPresentation(id: $0, ownershipState: "unavailable", available: false)
  }
  @Published private(set) var advancedDetails: AgentSettingsAdvancedDetails?
  @Published private(set) var lastVerification: [SetupAgentID: Date] = [:]
  @Published private(set) var busyAgent: SetupAgentID?
  @Published private(set) var loading = false
  @Published private(set) var errorMessage: String?

  var busy: Bool { loading || busyAgent != nil }

  private let runner: any AgentConnectionCommandRunning
  private let applicationOpener: any AgentApplicationOpening

  init(
    runner: any AgentConnectionCommandRunning,
    applicationOpener: any AgentApplicationOpening = LocalAgentApplicationOpener()
  ) {
    self.runner = runner
    self.applicationOpener = applicationOpener
  }

  static func bundled() -> AgentSettingsStore {
    do {
      let runtime = try EmbeddedRuntimeLocator.locate()
      return AgentSettingsStore(runner: AgentConnectionCommandRunner(runtime: runtime))
    } catch {
      return AgentSettingsStore(runner: UnavailableAgentConnectionRunner())
    }
  }

  func load() async {
    guard !busy else { return }
    loading = true
    errorMessage = nil
    defer { loading = false }
    await refreshAll()
  }

  func validActions(for connection: AgentConnectionPresentation) -> [AgentSettingsAction] {
    AgentConnectionPresentation.validActions(
      for: connection,
      canOpen: applicationOpener.canOpen(connection.id)
    )
  }

  func perform(_ action: AgentSettingsAction, for id: SetupAgentID) async {
    guard !busy, let current = connections.first(where: { $0.id == id }),
      validActions(for: current).contains(action)
    else { return }
    if action == .open {
      if !applicationOpener.open(id) {
        errorMessage = "The agent application could not be opened."
      }
      return
    }

    busyAgent = id
    errorMessage = nil
    defer { busyAgent = nil }
    do {
      switch action {
      case .connect: try await runner.connect(id)
      case .test:
        connections = try await runner.connections()
        lastVerification[id] = Date()
        return
      case .repair: try await runner.repair(id)
      case .disconnect: try await runner.disconnect(id)
      case .open: return
      }
      connections = try await runner.connections()
      if action != .disconnect { lastVerification[id] = Date() }
    } catch let error as SetupClientError {
      errorMessage = SetupStore.sanitize(error.message)
    } catch {
      errorMessage = SetupStore.sanitize(error.localizedDescription)
    }
  }

  private func refreshAll() async {
    do {
      service = try await runner.serviceStatus()
    } catch {
      service = SetupServicePresentation(
        state: .unavailable,
        installed: false,
        running: false,
        verified: false
      )
      record(error)
    }
    do {
      connections = try await runner.connections()
      let now = Date()
      for connection in connections
      where ["ownedCurrent", "equivalentUnowned"].contains(connection.ownershipState) {
        lastVerification[connection.id] = now
      }
    } catch {
      record(error)
    }
    do {
      advancedDetails = try await runner.advancedDetails()
    } catch {
      advancedDetails = nil
      record(error)
    }
  }

  private func record(_ error: any Error) {
    guard errorMessage == nil else { return }
    if let error = error as? SetupClientError {
      errorMessage = SetupStore.sanitize(error.message)
    } else {
      errorMessage = SetupStore.sanitize(error.localizedDescription)
    }
  }
}

@MainActor
struct AgentSettingsView: View {
  @ObservedObject var store: AgentSettingsStore
  @State private var pendingMutation: PendingMutation?

  private struct PendingMutation: Identifiable {
    let action: AgentSettingsAction
    let agent: SetupAgentID
    var id: String { "\(agent.rawValue):\(action.rawValue)" }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Agents").font(.title2.weight(.semibold))
          Text("Manage each supported agent connection independently.")
            .font(.subheadline).foregroundStyle(.secondary)
        }
        serviceCard
        ForEach(store.connections) { connection in agentCard(connection) }
        if let error = store.errorMessage {
          Label(error, systemImage: "exclamationmark.triangle.fill")
            .font(.caption).foregroundStyle(.red).lineLimit(4).textSelection(.enabled)
            .accessibilityLabel("Connection error: \(error)")
        }
      }
      .padding(24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(width: SyncSettingsView.contentWidth)
    .frame(minHeight: SyncSettingsView.contentHeight, maxHeight: 520)
    .task { await store.load() }
    .confirmationDialog(
      confirmationTitle,
      isPresented: Binding(
        get: { pendingMutation != nil },
        set: { if !$0 { pendingMutation = nil } }
      ),
      titleVisibility: .visible
    ) {
      if let pendingMutation {
        Button(
          pendingMutation.action.rawValue,
          role: pendingMutation.action == .disconnect ? .destructive : nil
        ) {
          let mutation = pendingMutation
          self.pendingMutation = nil
          Task { await store.perform(mutation.action, for: mutation.agent) }
        }
        .keyboardShortcut(.defaultAction)
      }
      Button("Cancel", role: .cancel) { pendingMutation = nil }
        .keyboardShortcut(.cancelAction)
    } message: {
      Text(confirmationMessage)
    }
  }

  private var serviceCard: some View {
    HStack(spacing: 12) {
      Image(systemName: store.service.verified ? "checkmark.circle.fill" : "circle.dashed")
        .foregroundStyle(store.service.verified ? .green : .secondary)
      VStack(alignment: .leading, spacing: 2) {
        Text("Pimpampum service").font(.headline)
        Text(store.service.state.label).font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      if store.loading { ProgressView().controlSize(.small) }
    }
    .padding(14)
    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Pimpampum service, \(store.service.state.accessibilityLabel)")
  }

  private func agentCard(_ connection: AgentConnectionPresentation) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(connection.id.displayName).font(.headline)
          Text(connection.stateLabel).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        if store.busyAgent == connection.id { ProgressView().controlSize(.small) }
      }
      HStack(spacing: 8) {
        ForEach(store.validActions(for: connection), id: \.self) { action in
          actionButton(action, connection: connection)
        }
      }
      DisclosureGroup("Advanced") {
        advancedContent(connection)
      }
      .frame(minHeight: 44)
      .accessibilityLabel("Advanced connection details for \(connection.id.displayName)")
    }
    .padding(14)
    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(connection.id.displayName), \(connection.stateLabel)")
    .accessibilityHint("Connection states include Not installed and Configuration conflict.")
  }

  @ViewBuilder private func actionButton(
    _ action: AgentSettingsAction,
    connection: AgentConnectionPresentation
  ) -> some View {
    let button = Button(action.rawValue) {
      if action.mutatesHost {
        pendingMutation = PendingMutation(action: action, agent: connection.id)
      } else {
        Task { await store.perform(action, for: connection.id) }
      }
    }
    .frame(minHeight: 44)
    .disabled(store.busy)
    .accessibilityLabel("\(action.rawValue) \(connection.id.displayName)")
    .accessibilityHint(actionHint(action))

    if action == .connect {
      button.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
    } else if action == .disconnect {
      button.buttonStyle(.bordered).tint(.red)
    } else {
      button.buttonStyle(.bordered)
    }
  }

  private func advancedContent(_ connection: AgentConnectionPresentation) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      detail("Launcher path", store.advancedDetails?.launcherPath ?? "Unavailable")
      detail("Transport", store.advancedDetails?.transport ?? "stdio")
      detail("Last verification", verificationLabel(connection.id))
      detail(
        "Manual instructions",
        store.advancedDetails?.manualInstructions
          ?? "Open the agent's MCP settings and follow its built-in connection guidance."
      )
    }
    .padding(.top, 8)
  }

  private func detail(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      Text(String(value.prefix(1_024)))
        .font(label == "Launcher path" ? .system(.caption, design: .monospaced) : .caption)
        .lineLimit(4).truncationMode(.middle).textSelection(.enabled)
    }
  }

  private func verificationLabel(_ id: SetupAgentID) -> String {
    store.lastVerification[id]?.formatted(date: .abbreviated, time: .shortened) ?? "Never"
  }

  private func actionHint(_ action: AgentSettingsAction) -> String {
    switch action {
    case .connect: "Adds only this agent's Pimpampum connection after confirmation."
    case .test: "Checks this agent's connection without changing it."
    case .repair: "Repairs only a connection already managed by Pimpampum."
    case .open: "Opens the installed agent application."
    case .disconnect: "Removes only this agent connection and preserves the service and data."
    }
  }

  private var confirmationTitle: String {
    guard let pendingMutation else { return "Confirm connection change" }
    return "\(pendingMutation.action.rawValue) \(pendingMutation.agent.displayName)?"
  }

  private var confirmationMessage: String {
    guard let pendingMutation else { return "No change has been selected." }
    if pendingMutation.action == .disconnect {
      return
        "Only the \(pendingMutation.agent.displayName) connection is removed. The Pimpampum service and all data stay in place."
    }
    return
      "Only the \(pendingMutation.agent.displayName) connection is changed. Other agents are left unchanged."
  }
}
