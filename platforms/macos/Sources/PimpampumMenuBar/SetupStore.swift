import Combine
import Foundation

protocol SetupAgentDetecting: Sendable {
  func detect() async -> Set<SetupAgentID>
}

struct LocalSetupAgentDetector: SetupAgentDetecting {
  private let homeDirectory: URL

  init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) {
    self.homeDirectory = homeDirectory
  }

  func detect() async -> Set<SetupAgentID> {
    var detected: Set<SetupAgentID> = []
    if Self.containsRegularItem([
      URL(fileURLWithPath: "/Applications/Codex.app"),
      homeDirectory.appendingPathComponent("Applications/Codex.app"),
      homeDirectory.appendingPathComponent(".local/bin/codex"),
      URL(fileURLWithPath: "/opt/homebrew/bin/codex"),
      URL(fileURLWithPath: "/usr/local/bin/codex"),
    ]) {
      detected.insert(.codex)
    }
    if Self.containsRegularItem([
      URL(fileURLWithPath: "/Applications/Claude.app"),
      homeDirectory.appendingPathComponent("Applications/Claude.app"),
      homeDirectory.appendingPathComponent(".local/bin/claude"),
      URL(fileURLWithPath: "/opt/homebrew/bin/claude"),
      URL(fileURLWithPath: "/usr/local/bin/claude"),
    ]) {
      detected.insert(.claudeCode)
    }
    return detected
  }

  private static func containsRegularItem(_ urls: [URL]) -> Bool {
    urls.contains { url in
      // Agent CLIs install themselves as symlinks into ~/.local/bin, so refusing links made Codex
      // undetectable on a standard installation. Detection only reads presence: nothing is executed
      // or written through this path, so the link is resolved and its target inspected instead.
      let resolved = url.resolvingSymlinksInPath()
      guard
        let values = try? resolved.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
      else { return false }
      return values.isRegularFile == true || values.isDirectory == true
    }
  }
}

@MainActor
final class SetupStore: ObservableObject {
  @Published private(set) var activity: SetupActivity = .idle
  @Published private(set) var agents: [SetupAgentSelection] = []
  @Published private(set) var plan: SetupPlan?
  @Published private(set) var progress: [SetupProgressEvent] = []
  @Published private(set) var service = SetupServicePresentation(
    state: .notInstalled,
    installed: false,
    running: false,
    verified: false
  )
  @Published private(set) var agentResults: [SetupAgentPresentation] = []
  @Published private(set) var completion: SetupResult?
  @Published private(set) var errorMessage: String?
  @Published private(set) var unresolvedConflicts: [SetupConflict] = []
  @Published private(set) var pendingApplicationRelaunch = false

  var busy: Bool { activity.isBusy }
  var selectedAgents: [SetupAgentID] { agents.filter(\.selected).map(\.id) }
  /// Connecting an agent is optional. The spec's success metrics require setup with no supported
  /// agents to complete, and the coordinator already handles an empty selection. Demanding one
  /// here left the service uninstallable on any Mac where nothing was detected.
  var canReview: Bool { !busy }
  var canCancel: Bool { activity.isBusy && !activity.hasBegunMutation }
  var needsLoginItemApproval: Bool { completion?.nextAction == .recoverLoginItem }

  private let runner: any SetupCommandRunning
  private let detector: any SetupAgentDetecting
  private var actionTask: Task<Void, Never>?
  private var started = false
  private var conflictDecisions: [SetupAgentID: SetupConflictDecision] = [:]

  init(
    runner: any SetupCommandRunning,
    detector: any SetupAgentDetecting = LocalSetupAgentDetector()
  ) {
    self.runner = runner
    self.detector = detector
  }

  static func bundled() -> SetupStore {
    do {
      return SetupStore(
        runner: SetupCommandRunner(bootstrap: try EmbeddedSetupBootstrap.bundled())
      )
    } catch {
      return SetupStore(runner: UnavailableSetupCommandRunner())
    }
  }

  deinit { actionTask?.cancel() }

  /// Called when the popover/store is created. The durable CLI journal, rather than view state,
  /// decides whether the same confirmed operation must resume after the app is reopened.
  func start() {
    guard !started else { return }
    started = true
    actionTask = Task { [weak self] in
      guard let self else { return }
      defer { actionTask = nil }
      await prepare()
      await resume()
    }
  }

  func prepare() async {
    guard activity == .idle else { return }
    activity = .detecting
    errorMessage = nil
    let detected = await detector.detect()
    guard !Task.isCancelled else {
      activity = .idle
      return
    }
    agents = SetupAgentID.allCases.map { id in
      let selection = SetupAgentSelection(
        id: id,
        detected: detected.contains(id),
        supported: true,
        selected: false
      )
      return SetupAgentSelection(
        id: id,
        detected: selection.detected,
        supported: selection.supported,
        selected: selection.selectedByDefault
      )
    }
    activity = .idle
  }

  func setSelected(_ selected: Bool, for id: SetupAgentID) {
    guard !activity.hasBegunMutation,
      let index = agents.firstIndex(where: { $0.id == id })
    else { return }
    agents[index].selected = selected
    plan = nil
  }

  func beginReview() {
    guard actionTask == nil else { return }
    actionTask = Task { [weak self] in
      guard let self else { return }
      defer { actionTask = nil }
      await review()
    }
  }

  func review() async {
    guard activity == .idle else { return }
    activity = .planning
    errorMessage = nil
    progress = []
    completion = nil
    defer { activity = .idle }
    do {
      plan = try await runner.plan(selectedConnectors: selectedAgents)
      unresolvedConflicts = plan?.conflicts ?? []
      conflictDecisions = [:]
    } catch is CancellationError {
      errorMessage = SetupClientError.cancelled.message
    } catch let error as SetupClientError {
      errorMessage = Self.sanitize(error.message)
    } catch {
      errorMessage = Self.sanitize(error.localizedDescription)
    }
  }

  func apply(
    replacing: [SetupAgentID] = [],
    keeping: [SetupAgentID] = []
  ) async {
    guard activity == .idle, let plan else { return }
    activity = .applying
    errorMessage = nil
    progress = []
    markSelectedAgentsConnecting()
    defer { activity = .idle }
    do {
      let result = try await runner.apply(
        operationID: plan.operationId,
        revision: plan.revision,
        replacing: replacing,
        keeping: keeping
      ) { [weak self] event in
        await self?.receive(event)
      }
      receive(result)
      pendingApplicationRelaunch = result.service.installed
    } catch let error as SetupClientError {
      errorMessage = Self.sanitize(error.message)
    } catch {
      errorMessage = Self.sanitize(error.localizedDescription)
    }
  }

  /// Relaunching terminates this process. Doing it inside `apply` meant the view never reached
  /// `onFinished`, so the popover kept showing a half-finished setup until it was reopened. The
  /// caller runs this once the outcome is on screen and the popover has moved on.
  func relaunchInstalledApplicationIfNeeded() async {
    guard pendingApplicationRelaunch else { return }
    pendingApplicationRelaunch = false
    _ = try? await runner.relaunchInstalledApplicationIfNeeded()
  }

  func resolveConflict(_ id: SetupAgentID, decision: SetupConflictDecision) async {
    guard unresolvedConflicts.contains(where: { $0.connectorId == id }) else { return }
    conflictDecisions[id] = decision
    unresolvedConflicts.removeAll(where: { $0.connectorId == id })
    guard unresolvedConflicts.isEmpty else { return }
    await apply(
      replacing: conflictDecisions.compactMap { $0.value == .replace ? $0.key : nil },
      keeping: conflictDecisions.compactMap { $0.value == .keep ? $0.key : nil }
    )
  }

  func cancelConflict() {
    guard !activity.hasBegunMutation else { return }
    plan = nil
    completion = nil
    progress = []
    unresolvedConflicts = []
    conflictDecisions = [:]
    errorMessage = nil
    service = SetupServicePresentation(
      state: .notInstalled,
      installed: false,
      running: false,
      verified: false
    )
    agentResults = []
  }

  func retry(_ id: SetupAgentID) async {
    guard activity == .idle,
      let existing = agentResults.first(where: { $0.id == id }),
      !existing.available
    else { return }
    activity = .applying
    errorMessage = nil
    defer { activity = .idle }
    do {
      let result = try await runner.retry(id) { [weak self] event in
        await self?.receive(event)
      }
      receive(result)
      pendingApplicationRelaunch = result.service.installed
    } catch let error as SetupClientError {
      errorMessage = Self.sanitize(error.message)
    } catch {
      errorMessage = Self.sanitize(error.localizedDescription)
    }
  }

  func resume() async {
    guard activity == .idle else { return }
    // Reading the durable journal is not a mutation. Announcing `.resuming` before one is known to
    // be running sends the onboarding to its final step, which it never leaves, so a clean machine
    // shows "Setting up your private service" over a service nothing has begun to install.
    activity = .detecting
    errorMessage = nil
    defer { activity = .idle }
    do {
      guard let journal = try await runner.status() else { return }
      receive(journal)
      guard journal.status == .running else { return }
      activity = .resuming
      let result = try await runner.resume { [weak self] event in
        await self?.receive(event)
      }
      receive(result)
      pendingApplicationRelaunch = result.service.installed
    } catch let error as SetupClientError {
      errorMessage = Self.sanitize(error.message)
    } catch {
      errorMessage = Self.sanitize(error.localizedDescription)
    }
  }

  /// Planning/detection can be abandoned. Once setup apply or durable resume begins, cancellation
  /// is intentionally ignored so the child can finish its receipt-backed transaction and exit.
  func cancelBeforeMutation() {
    guard canCancel else { return }
    actionTask?.cancel()
  }

  private func markSelectedAgentsConnecting() {
    service.state = .connecting
    agentResults = selectedAgents.map {
      SetupAgentPresentation(
        id: $0,
        state: .connecting,
        configured: false,
        available: false,
        newSessionRequired: false,
        error: nil
      )
    }
  }

  private func receive(_ event: SetupProgressEvent) {
    progress.append(event)
    if event.phase.hasPrefix("service.") {
      service.state = event.status == .failed ? .unavailable : .connecting
    }
    guard let connectorID = event.connectorId,
      let index = agentResults.firstIndex(where: { $0.id == connectorID })
    else { return }
    switch event.status {
    case .started: agentResults[index].state = .connecting
    case .completed: break
    case .failed:
      agentResults[index].state = .needsRepair
      agentResults[index].error = event.diagnostic.map(Self.sanitize)
    }
  }

  private func receive(_ result: SetupResult) {
    completion = result
    service = Self.servicePresentation(result.service)
    agentResults = result.connectors.map(Self.agentPresentation)
    if result.status == .conflict {
      let known = Set(unresolvedConflicts.map(\.connectorId))
      unresolvedConflicts += result.connectors.compactMap { connector in
        guard connector.state.lowercased().contains("conflict"), !known.contains(connector.id)
        else { return nil }
        return SetupConflict(
          connectorId: connector.id,
          comparison: "The existing entry changed or differs from the reviewed Pimpampum route."
        )
      }
    } else {
      unresolvedConflicts = []
      conflictDecisions = [:]
    }
  }

  private func receive(_ journal: SetupJournal) {
    service = Self.servicePresentation(journal.service)
    let completed = Dictionary(
      journal.connectors.map { ($0.id, $0) },
      uniquingKeysWith: { existing, _ in existing }
    )
    agentResults = journal.selectedConnectors.map { id in
      if let connector = completed[id] { return Self.agentPresentation(connector) }
      return SetupAgentPresentation(
        id: id,
        state: journal.status == .running ? .connecting : .notConnected,
        configured: false,
        available: false,
        newSessionRequired: false,
        error: nil
      )
    }
    guard let result = Self.terminalResult(journal) else { return }
    receive(result)
    if journal.status == .failed, let diagnostic = journal.diagnostics.last {
      errorMessage = Self.sanitize(diagnostic)
    }
  }

  private static func terminalResult(_ journal: SetupJournal) -> SetupResult? {
    let status: SetupCompletionStatus
    switch journal.status {
    case .running: return nil
    case .complete: status = .complete
    case .partial: status = .partial
    case .conflict: status = .conflict
    case .failed: status = .failed
    }
    let nextAction: SetupNextAction
    if status == .conflict {
      nextAction = .resolveConflict
    } else if status == .partial || status == .failed {
      nextAction = .retry
    } else if journal.connectors.contains(where: \.newSessionRequired) {
      nextAction = .newSession
    } else if journal.loginItem == "requires-approval" || journal.loginItem == "denied" {
      nextAction = .recoverLoginItem
    } else {
      nextAction = .done
    }
    return SetupResult(
      status: status,
      service: journal.service,
      connectors: journal.connectors,
      nextAction: nextAction
    )
  }

  private static func servicePresentation(_ result: SetupServiceResult)
    -> SetupServicePresentation
  {
    let state: SetupComponentState =
      result.verified ? .connected : result.installed ? .unavailable : .notInstalled
    return SetupServicePresentation(
      state: state,
      installed: result.installed,
      running: result.running,
      verified: result.verified
    )
  }

  private static func agentPresentation(_ result: SetupConnectorResult) -> SetupAgentPresentation {
    let normalized = result.state.lowercased()
    let state: SetupComponentState
    if normalized.contains("conflict") {
      state = .configurationConflict
    } else if normalized.contains("unsupported") {
      state = .unsupportedVersion
    } else if result.newSessionRequired {
      state = .newSessionRequired
    } else if result.available {
      state = .connected
    } else if result.configured || normalized.contains("repair") {
      state = .needsRepair
    } else {
      state = .notConnected
    }
    return SetupAgentPresentation(
      id: result.id,
      state: state,
      configured: result.configured,
      available: result.available,
      newSessionRequired: result.newSessionRequired,
      error: result.error.map(Self.sanitize)
    )
  }

  nonisolated static let maximumErrorLength = 240

  nonisolated static func sanitize(_ raw: String) -> String {
    var value =
      raw
      .replacingOccurrences(
        of: #"(?i)(authorization\s*:?\s*)?bearer\s+\S+"#,
        with: "[credential redacted]",
        options: .regularExpression
      )
      .replacingOccurrences(
        of: #"(?i)\b(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+"#,
        with: "[credential redacted]",
        options: .regularExpression
      )
      .replacingOccurrences(
        of: #"/(Users|home)/[^/\s]+"#,
        with: "~",
        options: .regularExpression
      )
    value =
      value
      .components(separatedBy: CharacterSet.whitespacesAndNewlines.union(.controlCharacters))
      .filter { !$0.isEmpty }
      .joined(separator: " ")
    if value.isEmpty { value = "Setup could not finish. Retry from Pimpampum." }
    return value.count <= maximumErrorLength
      ? value : "\(value.prefix(maximumErrorLength))…"
  }
}

private struct UnavailableSetupCommandRunner: SetupCommandRunning {
  func plan(selectedConnectors _: [SetupAgentID]) async throws -> SetupPlan {
    throw SetupClientError.unavailable
  }

  func apply(
    operationID _: String,
    revision _: String,
    replacing _: [SetupAgentID],
    keeping _: [SetupAgentID],
    onProgress _: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    throw SetupClientError.unavailable
  }

  func status() async throws -> SetupJournal? { throw SetupClientError.unavailable }

  func resume(
    onProgress _: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    throw SetupClientError.unavailable
  }

  func retry(
    _ id: SetupAgentID,
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    _ = id
    _ = onProgress
    throw SetupClientError.unavailable
  }
}
