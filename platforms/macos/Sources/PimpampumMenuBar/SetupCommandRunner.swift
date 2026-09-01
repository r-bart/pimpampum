import Foundation

protocol SetupCommandRunning: Sendable {
  func plan(selectedConnectors: [SetupAgentID]) async throws -> SetupPlan
  func apply(
    operationID: String,
    revision: String,
    replacing: [SetupAgentID],
    keeping: [SetupAgentID],
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult
  func status() async throws -> SetupJournal?
  func resume(
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult
  func retry(
    _ id: SetupAgentID,
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult
  /// `workspace:add` through the same packaged CLI, so a native install can register its first
  /// workspace without a terminal.
  func registerWorkspace(_ request: WorkspaceRegistrationRequest) async throws -> RegisteredWorkspace
  @MainActor func relaunchInstalledApplicationIfNeeded() async throws -> Bool
  /// Whether this process is the copy that stays after setup. Only that copy may register the
  /// login item for its own bundle.
  @MainActor func runsFromInstalledApplication() -> Bool
}

extension SetupCommandRunning {
  @MainActor func relaunchInstalledApplicationIfNeeded() async throws -> Bool { false }
  @MainActor func runsFromInstalledApplication() -> Bool { true }
}

struct SetupCommandOutput: Equatable, Sendable {
  let exitCode: Int32
  let standardOutput: Data
  let standardError: Data
  let exceededLimit: Bool
  let cancelled: Bool
}

protocol SetupProcessRunning: Sendable {
  func run(
    executable: URL,
    arguments: [String],
    cancellationAllowed: Bool
  ) async throws -> SetupCommandOutput
}

protocol SetupStreamingProcessRunning: SetupProcessRunning {
  func run(
    executable: URL,
    arguments: [String],
    cancellationAllowed: Bool,
    onStandardOutputLine: @escaping @Sendable (Data) -> Void
  ) async throws -> SetupCommandOutput
}

struct SetupCommandRunner: SetupCommandRunning {
  private let bootstrap: EmbeddedSetupBootstrap
  private let processRunner: any SetupProcessRunning
  private let relaunchAdapters: ApplicationRelaunchAdapters

  init(
    bootstrap: EmbeddedSetupBootstrap,
    processRunner: any SetupProcessRunning = LocalSetupProcessRunner(),
    relaunchAdapters: ApplicationRelaunchAdapters = .live
  ) {
    self.bootstrap = bootstrap
    self.processRunner = processRunner
    self.relaunchAdapters = relaunchAdapters
  }

  func plan(selectedConnectors: [SetupAgentID]) async throws -> SetupPlan {
    let invocation = bootstrap.plan(selectedConnectors: selectedConnectors)
    let events = try await run(invocation, cancellationAllowed: true)
    guard case .plan(let plan) = events.last else { throw SetupClientError.invalidResponse }
    return plan
  }

  func apply(
    operationID: String,
    revision: String,
    replacing: [SetupAgentID],
    keeping: [SetupAgentID],
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    let base = bootstrap.apply(
      operationID: operationID,
      revision: revision,
      replacing: replacing
    )
    let invocation = EmbeddedRuntimeInvocation(
      executableURL: base.executableURL,
      arguments: base.arguments
        + keeping.flatMap { ["--keep", $0.rawValue] }
        + ["--events"]
    )
    let events = try await run(
      invocation,
      cancellationAllowed: false,
      onProgress: onProgress
    )
    return try result(from: events)
  }

  func status() async throws -> SetupJournal? {
    let events = try await run(
      bootstrap.runtime.invocation(arguments: ["setup", "status"]),
      cancellationAllowed: true
    )
    guard case .journal(let journal) = events.last else {
      throw SetupClientError.invalidResponse
    }
    return journal
  }

  func resume(
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    let events = try await run(
      bootstrap.runtime.invocation(arguments: ["setup", "resume", "--events"]),
      cancellationAllowed: false,
      onProgress: onProgress
    )
    return try result(from: events)
  }

  func retry(
    _ id: SetupAgentID,
    onProgress: @escaping @Sendable (SetupProgressEvent) async -> Void
  ) async throws -> SetupResult {
    let events = try await run(
      bootstrap.runtime.invocation(arguments: ["setup", "retry", id.rawValue, "--events"]),
      cancellationAllowed: false,
      onProgress: onProgress
    )
    return try result(from: events)
  }

  func registerWorkspace(_ request: WorkspaceRegistrationRequest) async throws
    -> RegisteredWorkspace
  {
    // A write: like `apply`, it is never cut short by the caller's cancellation.
    let output = try await execute(
      bootstrap.runtime.invocation(arguments: request.arguments),
      cancellationAllowed: false,
      onProgress: nil
    )
    return try WorkspaceRegistrationDecoder.decode(output.standardOutput)
  }

  @MainActor
  func relaunchInstalledApplicationIfNeeded() async throws -> Bool {
    try await InstalledApplicationRelauncher(adapters: relaunchAdapters)
      .relaunchIfNeeded(bootstrap: bootstrap)
  }

  @MainActor
  func runsFromInstalledApplication() -> Bool {
    !bootstrap.requiresInstalledApplicationRelaunch
  }

  private func run(
    _ invocation: EmbeddedRuntimeInvocation,
    cancellationAllowed: Bool,
    onProgress: (@Sendable (SetupProgressEvent) async -> Void)? = nil
  ) async throws -> [SetupWireEvent] {
    let output = try await execute(
      invocation,
      cancellationAllowed: cancellationAllowed,
      onProgress: onProgress
    )
    return try SetupNDJSONDecoder.decode(output.standardOutput)
  }

  /// Runs the CLI and maps the process outcome to the stable errors; what the standard output
  /// means is the caller's decision.
  private func execute(
    _ invocation: EmbeddedRuntimeInvocation,
    cancellationAllowed: Bool,
    onProgress: (@Sendable (SetupProgressEvent) async -> Void)?
  ) async throws -> SetupCommandOutput {
    let lineHandler: @Sendable (Data) -> Void = { line in
      guard let onProgress,
        let events = try? SetupNDJSONDecoder.decode(line),
        events.count == 1,
        case .progress(let event) = events[0]
      else { return }
      // Backpressure keeps progress ordered and prevents an unbounded queue if a UI observer is
      // slow. This runs on the dedicated pipe-drain queue, never on the main actor.
      let delivered = DispatchSemaphore(value: 0)
      Task {
        await onProgress(event)
        delivered.signal()
      }
      delivered.wait()
    }
    let output: SetupCommandOutput
    if let streaming = processRunner as? any SetupStreamingProcessRunning {
      output = try await streaming.run(
        executable: invocation.executableURL,
        arguments: invocation.arguments,
        cancellationAllowed: cancellationAllowed,
        onStandardOutputLine: lineHandler
      )
    } else {
      output = try await processRunner.run(
        executable: invocation.executableURL,
        arguments: invocation.arguments,
        cancellationAllowed: cancellationAllowed
      )
    }
    if output.cancelled { throw SetupClientError.cancelled }
    if output.exceededLimit { throw SetupClientError.responseTooLarge }
    guard output.exitCode == 0 else {
      throw SetupClientError.commandFailed(Self.failureMessage(output.standardError))
    }
    return output
  }

  private func result(from events: [SetupWireEvent]) throws -> SetupResult {
    guard case .result(let result) = events.last else { throw SetupClientError.invalidResponse }
    return result
  }

  private struct FailureEnvelope: Decodable {
    struct Failure: Decodable { let message: String }
    let error: Failure
  }

  private static func failureMessage(_ data: Data) -> String {
    guard
      let envelope = try? JSONDecoder().decode(FailureEnvelope.self, from: data),
      !envelope.error.message.isEmpty
    else { return "The packaged setup command failed. Retry from Pimpampum." }
    return String(envelope.error.message.prefix(1_024))
  }
}

enum SetupNDJSONDecoder {
  static let maximumEventBytes = 65_536
  static let maximumEvents = 256

  static func decode(_ data: Data) throws -> [SetupWireEvent] {
    guard !data.isEmpty else { throw SetupClientError.invalidResponse }
    // `setup plan` and `setup status` have no `--events` mode, so they always leave the CLI as one
    // indented `{ "data": ... }` envelope spanning several lines. Only `apply`, `resume`, and
    // `retry` emit one event per line. Try the whole buffer as a single object before splitting,
    // because a line of an indented object is never valid JSON on its own.
    if (try? JSONSerialization.jsonObject(with: data)) != nil {
      guard data.count <= maximumEventBytes else { throw SetupClientError.responseTooLarge }
      return [try decodeLine(data)]
    }
    let lines = data.split(separator: 0x0A, omittingEmptySubsequences: true)
    guard !lines.isEmpty, lines.count <= maximumEvents else {
      throw SetupClientError.responseTooLarge
    }
    return try lines.map { line in
      guard line.count <= maximumEventBytes else { throw SetupClientError.responseTooLarge }
      return try decodeLine(Data(line))
    }
  }

  private static func decodeLine(_ line: Data) throws -> SetupWireEvent {
    guard
      let object = try? JSONSerialization.jsonObject(with: line),
      let dictionary = object as? [String: Any]
    else { throw SetupClientError.invalidResponse }

    let payload: Any
    let declaredEvent: String?
    if let event = dictionary["event"] as? String {
      guard dictionary["schemaVersion"] as? Int == setupSchemaVersion,
        let data = dictionary["data"]
      else { throw SetupClientError.incompatibleSchema }
      declaredEvent = event
      payload = data
    } else if let data = dictionary["data"] {
      declaredEvent = nil
      payload = data
    } else {
      declaredEvent = nil
      payload = dictionary
    }

    if payload is NSNull {
      guard declaredEvent == nil || declaredEvent == "journal" else {
        throw SetupClientError.invalidResponse
      }
      return .journal(nil)
    }
    guard JSONSerialization.isValidJSONObject(payload),
      let payloadData = try? JSONSerialization.data(withJSONObject: payload)
    else { throw SetupClientError.invalidResponse }
    let decoder = JSONDecoder()

    if let declaredEvent {
      switch declaredEvent {
      case "progress": return try progress(from: payloadData, decoder: decoder)
      case "plan": return try plan(from: payloadData, decoder: decoder)
      case "result": return try result(from: payloadData, decoder: decoder)
      case "journal": return try journal(from: payloadData, decoder: decoder)
      default: throw SetupClientError.invalidResponse
      }
    }
    if payloadDictionary(payload)?["occurredAt"] != nil {
      return try progress(from: payloadData, decoder: decoder)
    }
    if payloadDictionary(payload)?["requiresConfirmation"] != nil {
      return try plan(from: payloadData, decoder: decoder)
    }
    if payloadDictionary(payload)?["nextAction"] != nil {
      return try result(from: payloadData, decoder: decoder)
    }
    if payloadDictionary(payload)?["completedPhases"] != nil {
      return try journal(from: payloadData, decoder: decoder)
    }
    throw SetupClientError.invalidResponse
  }

  private static func progress(from data: Data, decoder: JSONDecoder) throws -> SetupWireEvent {
    guard let event = try? decoder.decode(SetupProgressEvent.self, from: data) else {
      throw SetupClientError.invalidResponse
    }
    guard event.schemaVersion == setupSchemaVersion else {
      throw SetupClientError.incompatibleSchema
    }
    try validate(event)
    return .progress(event)
  }

  private static func plan(from data: Data, decoder: JSONDecoder) throws -> SetupWireEvent {
    guard let plan = try? decoder.decode(SetupPlan.self, from: data) else {
      throw SetupClientError.invalidResponse
    }
    try validate(plan)
    return .plan(plan)
  }

  private static func result(from data: Data, decoder: JSONDecoder) throws -> SetupWireEvent {
    guard let result = try? decoder.decode(SetupResult.self, from: data) else {
      throw SetupClientError.invalidResponse
    }
    try validate(result)
    return .result(result)
  }

  private static func journal(from data: Data, decoder: JSONDecoder) throws -> SetupWireEvent {
    guard let journal = try? decoder.decode(SetupJournal.self, from: data) else {
      throw SetupClientError.invalidResponse
    }
    guard journal.schemaVersion == setupSchemaVersion else {
      throw SetupClientError.incompatibleSchema
    }
    try validate(journal)
    return .journal(journal)
  }

  private static func payloadDictionary(_ payload: Any) -> [String: Any]? {
    payload as? [String: Any]
  }

  private static func bounded(_ value: String, maximum: Int = 1_024) -> Bool {
    !value.isEmpty && value.count <= maximum && !value.contains("\0")
  }

  private static func boundedArgumentIdentifier(_ value: String) -> Bool {
    guard bounded(value, maximum: 128), value.first != "-" else { return false }
    return value.unicodeScalars.allSatisfy {
      CharacterSet.alphanumerics.contains($0) || "._:-".unicodeScalars.contains($0)
    }
  }

  private static func validate(_ plan: SetupPlan) throws {
    guard boundedArgumentIdentifier(plan.operationId), boundedArgumentIdentifier(plan.revision),
      plan.selectedConnectors.count <= SetupAgentID.allCases.count,
      Set(plan.selectedConnectors).count == plan.selectedConnectors.count,
      plan.changes.count <= 32, plan.conflicts.count <= SetupAgentID.allCases.count,
      plan.changes.allSatisfy({ bounded($0.kind, maximum: 128) && bounded($0.summary) }),
      plan.conflicts.allSatisfy({ bounded($0.comparison) })
    else { throw SetupClientError.invalidResponse }
  }

  private static func validate(_ event: SetupProgressEvent) throws {
    guard bounded(event.operationId, maximum: 128), bounded(event.phase, maximum: 128),
      bounded(event.occurredAt, maximum: 128),
      event.diagnostic.map({ $0.count <= 1_024 && !$0.contains("\0") }) ?? true
    else { throw SetupClientError.invalidResponse }
  }

  private static func validate(_ result: SetupResult) throws {
    guard result.connectors.count <= SetupAgentID.allCases.count,
      Set(result.connectors.map(\.id)).count == result.connectors.count,
      result.connectors.allSatisfy({
        bounded($0.state, maximum: 128)
          && ($0.error.map { $0.count <= 1_024 && !$0.contains("\0") } ?? true)
      })
    else { throw SetupClientError.invalidResponse }
  }

  private static func validate(_ journal: SetupJournal) throws {
    guard boundedArgumentIdentifier(journal.operationId),
      boundedArgumentIdentifier(journal.revision),
      bounded(journal.phase, maximum: 128), journal.completedPhases.count <= 64,
      journal.selectedConnectors.count <= SetupAgentID.allCases.count,
      journal.connectors.count <= SetupAgentID.allCases.count,
      Set(journal.selectedConnectors).count == journal.selectedConnectors.count,
      Set(journal.connectors.map(\.id)).count == journal.connectors.count,
      journal.completedPhases.allSatisfy({ bounded($0, maximum: 128) }),
      journal.diagnostics.count <= 64,
      journal.diagnostics.allSatisfy({ $0.count <= 1_024 && !$0.contains("\0") }),
      journal.connectors.allSatisfy({
        bounded($0.state, maximum: 128)
          && ($0.error.map { $0.count <= 1_024 && !$0.contains("\0") } ?? true)
      }),
      ["pending", "enabled", "requires-approval", "denied"].contains(journal.loginItem),
      bounded(journal.updatedAt, maximum: 128)
    else { throw SetupClientError.invalidResponse }
  }
}

struct LocalSetupProcessRunner: SetupStreamingProcessRunning {
  static let maximumStreamBytes = 1_048_576

  func run(
    executable: URL,
    arguments: [String],
    cancellationAllowed: Bool
  ) async throws -> SetupCommandOutput {
    try await run(
      executable: executable,
      arguments: arguments,
      cancellationAllowed: cancellationAllowed,
      onStandardOutputLine: { _ in }
    )
  }

  func run(
    executable: URL,
    arguments: [String],
    cancellationAllowed: Bool,
    onStandardOutputLine: @escaping @Sendable (Data) -> Void
  ) async throws -> SetupCommandOutput {
    let watchdog = SetupProcessWatchdog()
    return try await withTaskCancellationHandler {
      try await Task.detached {
        let process = Process()
        let output = Pipe()
        let failure = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = Self.privateEnvironment()
        process.standardOutput = output
        process.standardError = failure
        try process.run()
        watchdog.attach(process)
        async let standardOutput = Self.drain(output, onLine: onStandardOutputLine)
        async let standardError = Self.drain(failure, onLine: nil)
        let streams = await (standardOutput, standardError)
        process.waitUntilExit()
        let cancelled = watchdog.finish()
        return SetupCommandOutput(
          exitCode: process.terminationStatus,
          standardOutput: streams.0.data,
          standardError: streams.1.data,
          exceededLimit: streams.0.exceededLimit || streams.1.exceededLimit,
          cancelled: cancelled
        )
      }.value
    } onCancel: {
      if cancellationAllowed { watchdog.cancel() }
    }
  }

  private struct DrainResult: Sendable {
    var data: Data
    var exceededLimit: Bool
  }

  private static func drain(
    _ pipe: Pipe,
    onLine: (@Sendable (Data) -> Void)?
  ) async -> DrainResult {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        let handle = pipe.fileHandleForReading
        var result = Data()
        var exceeded = false
        var line = Data()
        var lineExceeded = false
        while true {
          let chunk = handle.readData(ofLength: 16_384)
          if chunk.isEmpty { break }
          let remaining = maximumStreamBytes - result.count
          if remaining > 0 { result.append(chunk.prefix(remaining)) }
          if chunk.count > remaining { exceeded = true }
          if let onLine {
            for byte in chunk {
              if byte == 0x0A {
                if !lineExceeded && !line.isEmpty { onLine(line) }
                line.removeAll(keepingCapacity: true)
                lineExceeded = false
              } else if line.count < SetupNDJSONDecoder.maximumEventBytes {
                line.append(byte)
              } else {
                lineExceeded = true
              }
            }
          }
        }
        if let onLine, !lineExceeded, !line.isEmpty { onLine(line) }
        continuation.resume(returning: DrainResult(data: result, exceededLimit: exceeded))
      }
    }
  }

  private static func privateEnvironment() -> [String: String] {
    let source = ProcessInfo.processInfo.environment
    let allowed = ["HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
    return Dictionary(
      uniqueKeysWithValues: allowed.compactMap { key in
        source[key].map { (key, $0) }
      })
  }
}

final class SetupProcessWatchdog: @unchecked Sendable {
  private let lock = NSLock()
  private var process: Process?
  private var cancellationRequested = false
  private var completed = false

  func attach(_ process: Process) {
    lock.lock()
    self.process = process
    let shouldTerminate = cancellationRequested && !completed
    lock.unlock()
    if shouldTerminate { process.terminate() }
  }

  func cancel() {
    lock.lock()
    cancellationRequested = true
    let process = completed ? nil : process
    lock.unlock()
    process?.terminate()
  }

  func finish() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    completed = true
    return cancellationRequested
  }
}
