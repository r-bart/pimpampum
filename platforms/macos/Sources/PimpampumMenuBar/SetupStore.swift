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
  /// How often the journal of a setup another process owns is re-read.
  static let runningJournalPollInterval: TimeInterval = 2
  /// Consecutive polls with an unchanged `updatedAt` after which the owner is presumed gone and
  /// this process resumes the operation itself. The CLI stamps the journal only at phase
  /// boundaries, and one phase (the runtime install, the login-item handshake) can run long, so a
  /// live owner gets two minutes per phase. The CLI recovers a lock whose holder died.
  static let stalledJournalPollLimit = 60

  @Published private(set) var activity: SetupActivity = .idle
  @Published private(set) var agents: [SetupAgentSelection] = []
  @Published private(set) var plan: SetupPlan?
  @Published private(set) var progress: [SetupProgressEvent] = []
  @Published private(set) var service = SetupStore.uninstalledService
  @Published private(set) var agentResults: [SetupAgentPresentation] = []
  @Published private(set) var completion: SetupResult?
  @Published private(set) var errorMessage: String?
  @Published private(set) var unresolvedConflicts: [SetupConflict] = []
  @Published private(set) var pendingApplicationRelaunch = false

  var busy: Bool { activity.isBusy }
  var selectedAgents: [SetupAgentID] { agents.filter(\.selected).map(\.id) }
  /// The confirmation applies the plan on screen, so there must be one and nothing may have failed.
  /// Connecting an agent is optional: the spec's success metrics require setup with no supported
  /// agents to complete, so an empty selection does not block the button.
  var canConfirm: Bool { !busy && plan != nil && errorMessage == nil }
  var needsLoginItemApproval: Bool { completion?.nextAction == .recoverLoginItem }
  /// Registering the login item names the running bundle. Only the installed copy may do it.
  var canRegisterLoginItemFromThisProcess: Bool { runner.runsFromInstalledApplication() }

  private static let uninstalledService = SetupServicePresentation(
    state: .notInstalled,
    installed: false,
    running: false,
    verified: false
  )

  private let runner: any SetupCommandRunning
  private let detector: any SetupAgentDetecting
  private let clock: any OverviewClock
  private var actionTask: Task<Void, Never>?
  private var launchWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
  private var started = false
  private var conflictDecisions: [SetupAgentID: SetupConflictDecision] = [:]

  init(
    runner: any SetupCommandRunning,
    detector: any SetupAgentDetecting = LocalSetupAgentDetector(),
    clock: any OverviewClock = SystemOverviewClock()
  ) {
    self.runner = runner
    self.detector = detector
    self.clock = clock
  }

  static func bundled(
    bootstrap: () throws -> EmbeddedSetupBootstrap = EmbeddedSetupBootstrap.bundledFromApplication
  ) -> SetupStore {
    do {
      return SetupStore(runner: SetupCommandRunner(bootstrap: try bootstrap()))
    } catch {
      return SetupStore(runner: UnavailableSetupCommandRunner())
    }
  }

  deinit { actionTask?.cancel() }

  /// Called when the session begins. The durable CLI journal, rather than view state, decides
  /// whether a confirmed operation is still in progress.
  func start() {
    guard !started else { return }
    started = true
    actionTask = Task { [weak self] in
      guard let self else { return }
      defer {
        actionTask = nil
        resumeLaunchWaiters()
      }
      await prepare()
      await resume()
    }
  }

  /// Suspends until the launch task has finished, or until the caller is cancelled. Awaiting the
  /// task's value directly would ignore cancellation and keep a view's task alive forever when the
  /// launch is stuck.
  private func awaitLaunchTask() async {
    guard actionTask != nil else { return }
    let id = UUID()
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        if Task.isCancelled {
          continuation.resume()
        } else {
          launchWaiters[id] = continuation
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.resumeLaunchWaiter(id) }
    }
  }

  private func resumeLaunchWaiter(_ id: UUID) {
    launchWaiters.removeValue(forKey: id)?.resume()
  }

  private func resumeLaunchWaiters() {
    let waiters = launchWaiters
    launchWaiters = [:]
    for waiter in waiters.values { waiter.resume() }
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

  func review() async {
    // Planning runs from the agents step as soon as it appears, which can be before the launch task
    // has finished detecting agents and reading the journal. Returning early left no plan and no
    // error under an enabled button, so wait for that task instead.
    await awaitLaunchTask()
    guard !Task.isCancelled, activity == .idle else { return }
    activity = .planning
    errorMessage = nil
    progress = []
    completion = nil
    defer { activity = .idle }
    do {
      let reviewed = try await runner.plan(selectedConnectors: selectedAgents)
      plan = reviewed
      unresolvedConflicts = reviewed.conflicts
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

  /// Forgets the plan and any outcome so the onboarding can start again. A mutation in flight is
  /// never abandoned: the child finishes its receipt-backed transaction first.
  func reset() {
    guard !activity.hasBegunMutation else { return }
    plan = nil
    completion = nil
    unresolvedConflicts = []
    conflictDecisions = [:]
    errorMessage = nil
    clearProgress()
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
      // Only a running journal is a setup in progress. A finished or failed one is history: shown
      // as the current outcome it stranded every reinstall on a stale final step.
      guard let journal = try await runner.status(), journal.status == .running else { return }
      receive(journal)
      activity = .resuming
      guard try await followRunningJournal(journal) != nil else { return }
      // The owner stopped writing the journal. The CLI recovers its stale lock, so the operation
      // can finish from here.
      let result = try await runner.resume { [weak self] event in
        await self?.receive(event)
      }
      receive(result)
      pendingApplicationRelaunch = result.service.installed
    } catch is CancellationError {
      return
    } catch let error as SetupClientError {
      errorMessage = Self.sanitize(error.message)
    } catch {
      errorMessage = Self.sanitize(error.localizedDescription)
    }
  }

  /// Another process, usually the copy that started setup, is applying and holds the lifecycle
  /// lock. `setup resume` would wait for that lock and time out, so the journal is watched instead.
  /// Returns nil once it reached a final state or disappeared, and the last journal when its owner
  /// stopped updating it.
  private func followRunningJournal(_ initial: SetupJournal) async throws -> SetupJournal? {
    var latest = initial
    var unchangedPolls = 0
    while unchangedPolls < Self.stalledJournalPollLimit {
      try await clock.sleep(for: Self.runningJournalPollInterval)
      guard let current = try await runner.status() else {
        clearProgress()
        return nil
      }
      receive(current)
      guard current.status == .running else { return nil }
      if current.updatedAt == latest.updatedAt {
        unchangedPolls += 1
      } else {
        unchangedPolls = 0
        latest = current
      }
    }
    return latest
  }

  private func clearProgress() {
    progress = []
    service = Self.uninstalledService
    agentResults = []
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
    let completed = Dictionary(
      journal.connectors.map { ($0.id, $0) },
      uniquingKeysWith: { existing, _ in existing }
    )
    // Every agent the user selected keeps a row, including one the journal has no result for yet;
    // a result alone would drop it.
    let rows = journal.selectedConnectors.map { id in
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
    if let result = Self.terminalResult(journal) {
      receive(result)
      if journal.status == .failed, let diagnostic = journal.diagnostics.last {
        errorMessage = Self.sanitize(diagnostic)
      }
    }
    service = Self.servicePresentation(journal.service)
    agentResults = rows
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

struct UnavailableSetupCommandRunner: SetupCommandRunning {
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
