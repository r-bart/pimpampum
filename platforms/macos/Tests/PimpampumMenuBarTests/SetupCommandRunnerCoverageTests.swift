import Foundation
import Testing

@testable import PimpampumMenuBar

private struct ScriptedProcessRunner: SetupProcessRunning {
  let output: SetupCommandOutput

  func run(executable _: URL, arguments _: [String], cancellationAllowed _: Bool) async throws
    -> SetupCommandOutput
  {
    output
  }
}

private actor ScriptedStreamingProcessRunner: SetupStreamingProcessRunning {
  let lines: [Data]
  let output: SetupCommandOutput
  private(set) var arguments: [String] = []

  init(lines: [Data], output: SetupCommandOutput) {
    self.lines = lines
    self.output = output
  }

  func run(executable: URL, arguments: [String], cancellationAllowed: Bool) async throws
    -> SetupCommandOutput
  {
    try await run(
      executable: executable, arguments: arguments, cancellationAllowed: cancellationAllowed,
      onStandardOutputLine: { _ in })
  }

  func run(
    executable _: URL,
    arguments: [String],
    cancellationAllowed _: Bool,
    onStandardOutputLine: @escaping @Sendable (Data) -> Void
  ) async throws -> SetupCommandOutput {
    self.arguments = arguments
    for line in lines { onStandardOutputLine(line) }
    return output
  }
}

private actor LineRecorder {
  private(set) var lines: [Data] = []
  private(set) var events: [SetupProgressEvent] = []
  func append(_ line: Data) { lines.append(line) }
  func append(_ event: SetupProgressEvent) { events.append(event) }
}

private func output(
  exitCode: Int32 = 0,
  stdout: String = "",
  stderr: String = "",
  exceededLimit: Bool = false,
  cancelled: Bool = false
) -> SetupCommandOutput {
  SetupCommandOutput(
    exitCode: exitCode,
    standardOutput: Data(stdout.utf8),
    standardError: Data(stderr.utf8),
    exceededLimit: exceededLimit,
    cancelled: cancelled
  )
}

private let resultLine =
  #"{"schemaVersion":1,"event":"result","data":{"status":"complete","service":{"installed":true,"running":true,"verified":true},"connectors":[{"id":"codex","configured":true,"available":true,"newSessionRequired":false,"state":"connected","error":"none"}],"nextAction":"done"}}"#
private let progressLine =
  #"{"schemaVersion":1,"event":"progress","data":{"schemaVersion":1,"operationId":"operation","phase":"connector:codex.verify","status":"completed","occurredAt":"2026-08-31T10:00:00.000Z","connectorId":"codex","diagnostic":"fine"}}"#
private let planLine =
  #"{"schemaVersion":1,"event":"plan","data":{"operationId":"operation","revision":"revision","selectedConnectors":["codex"],"changes":[{"kind":"runtime","summary":"Install","path":"/tmp/runtime"}],"conflicts":[{"connectorId":"codex","comparison":"differs"}],"requiresConfirmation":true}}"#
private let journalLine =
  #"{"schemaVersion":1,"event":"journal","data":{"schemaVersion":1,"operationId":"operation","revision":"revision","phase":"complete","selectedConnectors":["codex"],"completedPhases":["runtime.install"],"diagnostics":["slow disk"],"service":{"installed":true,"running":true,"verified":true},"connectors":[{"id":"codex","configured":true,"available":true,"newSessionRequired":false,"state":"connected","error":"none"}],"loginItem":"enabled","status":"complete","updatedAt":"2026-08-31T10:00:00.000Z"}}"#

private func bootstrap() -> EmbeddedSetupBootstrap {
  let home = URL(fileURLWithPath: "/Users/example")
  return EmbeddedSetupBootstrap(
    runtime: EmbeddedControlRuntime(
      rootURL: home.appendingPathComponent("runtime"),
      executableURL: home.appendingPathComponent("runtime/bin/node"),
      cliURL: home.appendingPathComponent("runtime/dist/cli.js")
    ),
    sourceApplicationURL: home.appendingPathComponent("Downloads/Pimpampum.app"),
    dataDirectory: home.appendingPathComponent(".pimpampum"),
    homeDirectory: home
  )
}

@Suite("Setup NDJSON decoder branches")
struct SetupNDJSONDecoderBranchTests {
  private func decode(_ text: String) throws -> [SetupWireEvent] {
    try SetupNDJSONDecoder.decode(Data(text.utf8))
  }

  @Test
  func decodesEveryDeclaredEventKind() throws {
    guard case .result(let result) = try decode(resultLine)[0] else {
      Issue.record("Expected result")
      return
    }
    #expect(result.connectors.first?.error == "none")
    guard case .plan(let plan) = try decode(planLine)[0] else {
      Issue.record("Expected plan")
      return
    }
    #expect(plan.conflicts.count == 1)
    guard case .journal(let journal) = try decode(journalLine)[0] else {
      Issue.record("Expected journal")
      return
    }
    #expect(journal?.diagnostics == ["slow disk"])
    guard case .progress(let progress) = try decode(progressLine)[0] else {
      Issue.record("Expected progress")
      return
    }
    #expect(progress.diagnostic == "fine")
    // A null journal may be declared or bare; a null anything else is an error.
    guard case .journal(nil) = try decode(#"{"schemaVersion":1,"event":"journal","data":null}"#)[0]
    else {
      Issue.record("Expected empty journal")
      return
    }
    #expect(throws: SetupClientError.invalidResponse) {
      try decode(#"{"schemaVersion":1,"event":"progress","data":null}"#)
    }
  }

  @Test
  func infersUndeclaredPayloadsByTheirDistinctiveField() throws {
    // A bare object without an envelope is the payload itself.
    let bareProgress =
      #"{"schemaVersion":1,"operationId":"operation","phase":"service.verify","status":"completed","occurredAt":"2026-08-31T10:00:00.000Z"}"#
    guard case .progress = try decode(bareProgress)[0] else {
      Issue.record("Expected progress")
      return
    }
    let bareJournal =
      #"{"data":{"schemaVersion":1,"operationId":"operation","revision":"revision","phase":"complete","selectedConnectors":["codex"],"completedPhases":[],"diagnostics":[],"service":{"installed":true,"running":true,"verified":true},"connectors":[{"id":"codex","configured":true,"available":true,"newSessionRequired":false,"state":"connected"}],"loginItem":"enabled","status":"complete","updatedAt":"2026-08-31T10:00:00.000Z"}}"#
    guard case .journal(.some) = try decode(bareJournal)[0] else {
      Issue.record("Expected journal")
      return
    }
    #expect(throws: SetupClientError.invalidResponse) { try decode(#"{"data":{"unknown":true}}"#) }
  }

  @Test(arguments: [
    "",
    "[1]",
    #""text""#,
    #"{"data":"text"}"#,
    #"{"schemaVersion":1,"event":"mystery","data":{}}"#,
    // Declared kind whose payload does not decode.
    #"{"schemaVersion":1,"event":"progress","data":{"schemaVersion":1}}"#,
    #"{"schemaVersion":1,"event":"plan","data":{"operationId":"o"}}"#,
    #"{"schemaVersion":1,"event":"result","data":{"status":"complete"}}"#,
    #"{"schemaVersion":1,"event":"journal","data":{"schemaVersion":1}}"#,
    // Payloads that decode but fail validation.
    #"{"schemaVersion":1,"event":"progress","data":{"schemaVersion":1,"operationId":"operation","phase":"","status":"completed","occurredAt":"2026-08-31T10:00:00.000Z"}}"#,
    #"{"data":{"operationId":"op/1","revision":"revision","selectedConnectors":[],"changes":[],"conflicts":[],"requiresConfirmation":true}}"#,
    #"{"data":{"status":"complete","service":{"installed":true,"running":true,"verified":true},"connectors":[{"id":"codex","configured":true,"available":true,"newSessionRequired":false,"state":"connected"},{"id":"codex","configured":true,"available":true,"newSessionRequired":false,"state":"connected"}],"nextAction":"done"}}"#,
    #"{"data":{"schemaVersion":1,"operationId":"operation","revision":"revision","phase":"complete","selectedConnectors":[],"completedPhases":[],"diagnostics":[],"service":{"installed":true,"running":true,"verified":true},"connectors":[],"loginItem":"unknown","status":"complete","updatedAt":"2026-08-31T10:00:00.000Z"}}"#,
  ])
  func rejectsMalformedInput(text: String) {
    #expect(throws: SetupClientError.invalidResponse) { try decode(text) }
  }

  @Test
  func rejectsIncompatibleSchemasWhereverTheyAppear() {
    #expect(throws: SetupClientError.incompatibleSchema) {
      try decode(#"{"schemaVersion":1,"event":"progress"}"#)
    }
    #expect(throws: SetupClientError.incompatibleSchema) {
      try decode(
        #"{"schemaVersion":1,"event":"progress","data":{"schemaVersion":2,"operationId":"operation","phase":"service.verify","status":"completed","occurredAt":"2026-08-31T10:00:00.000Z"}}"#
      )
    }
    #expect(throws: SetupClientError.incompatibleSchema) {
      try decode(
        #"{"data":{"schemaVersion":2,"operationId":"operation","revision":"revision","phase":"complete","selectedConnectors":[],"completedPhases":[],"diagnostics":[],"service":{"installed":true,"running":true,"verified":true},"connectors":[],"loginItem":"enabled","status":"complete","updatedAt":"2026-08-31T10:00:00.000Z"}}"#
      )
    }
  }

  @Test
  func boundsTheWholeBufferAndTheNumberOfLines() {
    let bigValid = #"{"data":""# + String(repeating: "a", count: SetupNDJSONDecoder.maximumEventBytes) + #""}"#
    #expect(throws: SetupClientError.responseTooLarge) { try decode(bigValid) }
    let tooManyLines = Array(repeating: "{}", count: SetupNDJSONDecoder.maximumEvents + 1)
      .joined(separator: "\n")
    #expect(throws: SetupClientError.responseTooLarge) { try decode(tooManyLines) }
    // Only newlines: no whole-buffer object and no line either.
    #expect(throws: SetupClientError.responseTooLarge) { try decode("\n\n") }
  }
}

@Suite("Setup command runner")
struct SetupCommandRunnerBranchTests {
  private func runner(_ process: any SetupProcessRunning) -> SetupCommandRunner {
    SetupCommandRunner(bootstrap: bootstrap(), processRunner: process)
  }

  @Test
  func eachCommandDemandsItsOwnKindOfAnswer() async throws {
    let planAnswer = runner(ScriptedProcessRunner(output: output(stdout: planLine)))
    await #expect(throws: SetupClientError.invalidResponse) { try await planAnswer.status() }
    await #expect(throws: SetupClientError.invalidResponse) { try await planAnswer.resume { _ in } }
    let resultAnswer = runner(ScriptedProcessRunner(output: output(stdout: resultLine)))
    await #expect(throws: SetupClientError.invalidResponse) {
      try await resultAnswer.plan(selectedConnectors: [])
    }
    let journal = try await runner(ScriptedProcessRunner(output: output(stdout: journalLine))).status()
    #expect(journal?.status == .complete)
  }

  @Test
  func passesEveryVerbAsAnArgumentArray() async throws {
    let process = ScriptedStreamingProcessRunner(lines: [], output: output(stdout: resultLine))
    let runner = runner(process)
    _ = try await runner.resume { _ in }
    #expect(await process.arguments.suffix(3) == ["setup", "resume", "--events"])
    _ = try await runner.retry(.codex) { _ in }
    #expect(await process.arguments.suffix(4) == ["setup", "retry", "codex", "--events"])
    _ = try await runner.apply(operationID: "o", revision: "r", replacing: [.codex], keeping: []) {
      _ in
    }
    let applyArguments = await process.arguments
    #expect(
      applyArguments.suffix(8)
        == ["setup", "apply", "o", "r", "--yes", "--replace", "codex", "--events"])
  }

  @Test
  func deliversOnlyProgressLinesAndOnlyWhenSomeoneListens() async throws {
    let recorder = LineRecorder()
    let noise = [Data("not json".utf8), Data(resultLine.utf8), Data(progressLine.utf8)]
    let process = ScriptedStreamingProcessRunner(lines: noise, output: output(stdout: resultLine))
    _ = try await runner(process).apply(operationID: "o", revision: "r", replacing: [], keeping: []) {
      event in
      await recorder.append(event)
    }
    #expect(await recorder.events.map(\.phase) == ["connector:codex.verify"])

    // Planning has no listener, so streamed lines are ignored.
    let planProcess = ScriptedStreamingProcessRunner(
      lines: [Data(progressLine.utf8)], output: output(stdout: planLine))
    let plan = try await runner(planProcess).plan(selectedConnectors: [.codex])
    #expect(plan.operationId == "operation")
  }

  @Test
  func mapsProcessOutcomesToStableErrors() async throws {
    await #expect(throws: SetupClientError.cancelled) {
      try await runner(ScriptedProcessRunner(output: output(cancelled: true))).status()
    }
    await #expect(throws: SetupClientError.responseTooLarge) {
      try await runner(ScriptedProcessRunner(output: output(exceededLimit: true))).status()
    }
    await #expect(throws: SetupClientError.commandFailed("Boom")) {
      try await runner(
        ScriptedProcessRunner(output: output(exitCode: 1, stderr: #"{"error":{"message":"Boom"}}"#))
      ).status()
    }
    let fallback = "The packaged setup command failed. Retry from Pimpampum."
    await #expect(throws: SetupClientError.commandFailed(fallback)) {
      try await runner(ScriptedProcessRunner(output: output(exitCode: 1, stderr: "garbage"))).status()
    }
    await #expect(throws: SetupClientError.commandFailed(fallback)) {
      try await runner(
        ScriptedProcessRunner(output: output(exitCode: 1, stderr: #"{"error":{"message":""}}"#))
      ).status()
    }
    let long = String(repeating: "m", count: 2_000)
    await #expect(throws: SetupClientError.commandFailed(String(repeating: "m", count: 1_024))) {
      try await runner(
        ScriptedProcessRunner(
          output: output(exitCode: 1, stderr: #"{"error":{"message":""# + long + #""}}"#))
      ).status()
    }
  }
}

@Suite("Local setup process runner")
struct LocalSetupProcessRunnerTests {
  @Test
  func capturesBothStreamsAndTheExitCode() async throws {
    let echo = try await LocalSetupProcessRunner().run(
      executable: URL(fileURLWithPath: "/bin/echo"), arguments: ["hello"], cancellationAllowed: false)
    #expect(echo.exitCode == 0)
    #expect(String(decoding: echo.standardOutput, as: UTF8.self) == "hello\n")
    #expect(!echo.exceededLimit)
    #expect(!echo.cancelled)

    let failure = try await LocalSetupProcessRunner().run(
      executable: URL(fileURLWithPath: "/bin/ls"),
      arguments: ["/nonexistent-\(UUID().uuidString)"],
      cancellationAllowed: false)
    #expect(failure.exitCode != 0)
    #expect(!failure.standardError.isEmpty)
  }

  @Test
  func capsAFloodedStreamAndDropsAnOversizedLine() async throws {
    // More than the stream cap, no newline: the stream is truncated and the single unbounded line
    // is never delivered.
    let recorder = LineRecorder()
    let flood = try await LocalSetupProcessRunner().run(
      executable: URL(fileURLWithPath: "/usr/bin/head"),
      arguments: ["-c", "\(LocalSetupProcessRunner.maximumStreamBytes + 200_000)", "/dev/zero"],
      cancellationAllowed: false
    ) { line in
      Task { await recorder.append(line) }
    }
    #expect(flood.exceededLimit)
    #expect(flood.standardOutput.count == LocalSetupProcessRunner.maximumStreamBytes)
    #expect(await recorder.lines.isEmpty)

    // A line past the event cap is skipped; the next line after its newline is delivered.
    let width = SetupNDJSONDecoder.maximumEventBytes + 1_000
    let mixed = try await LocalSetupProcessRunner().run(
      executable: URL(fileURLWithPath: "/usr/bin/printf"),
      arguments: ["%0\(width)d\nrest\n", "0"],
      cancellationAllowed: false
    ) { line in
      Task { await recorder.append(line) }
    }
    #expect(!mixed.exceededLimit)
    #expect(await eventually { await recorder.lines == [Data("rest".utf8)] })

    // A final line without a newline is still delivered at end of stream.
    let tail = LineRecorder()
    _ = try await LocalSetupProcessRunner().run(
      executable: URL(fileURLWithPath: "/usr/bin/printf"),
      arguments: ["tail"],
      cancellationAllowed: false
    ) { line in
      Task { await tail.append(line) }
    }
    #expect(await eventually { await tail.lines == [Data("tail".utf8)] })
  }

  @Test
  func theWatchdogTerminatesAChildWhateverTheOrderOfEvents() throws {
    // Cancellation arriving before the process is attached.
    let early = SetupProcessWatchdog()
    early.cancel()
    let sleeper = Process()
    sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
    sleeper.arguments = ["30"]
    try sleeper.run()
    early.attach(sleeper)
    sleeper.waitUntilExit()
    #expect(sleeper.terminationStatus != 0)
    #expect(early.finish())

    // A finished run ignores a late cancellation and does not touch the process.
    let late = SetupProcessWatchdog()
    let survivor = Process()
    survivor.executableURL = URL(fileURLWithPath: "/bin/sleep")
    survivor.arguments = ["30"]
    try survivor.run()
    late.attach(survivor)
    #expect(!late.finish())
    late.cancel()
    #expect(survivor.isRunning)
    survivor.terminate()
    survivor.waitUntilExit()
  }
}
