import Foundation

// Thin `Process` adapter. It returns both streams on every exit: `src/cli.ts` writes success data
// to stdout and its typed error envelope to stderr, so the covered store needs both to tell a real
// cause from a guess.
struct LocalUpdateCommandRunner: UpdateCommandRunning {
  func run(executable: URL, arguments: [String], timeout: Duration?) async throws
    -> UpdateCommandOutput
  {
    try await Task.detached {
      let process = Process()
      let output = Pipe()
      let failure = Pipe()
      process.executableURL = executable
      process.arguments = arguments
      process.standardOutput = output
      process.standardError = failure
      try process.run()
      let watchdog = UpdateProcessWatchdog(process)
      let deadline = timeout.map { watchdog.arm(after: $0) }
      // Both pipes drain at the same time. Reading one to EOF before starting the other lets the
      // child block once it fills the buffer of the stream nobody is draining, and then the read
      // that is waiting never reaches EOF either.
      async let standardOutput = Self.drain(output)
      async let standardError = Self.drain(failure)
      let streams = await (standardOutput, standardError)
      process.waitUntilExit()
      deadline?.cancel()
      // The watchdog decides, not the exit status: a terminated child and a child that failed on
      // its own both exit non-zero, and only one of them is a timeout.
      if watchdog.finish() { throw UpdateSettingsError.timedOut }
      return UpdateCommandOutput(
        exitCode: process.terminationStatus,
        standardOutput: streams.0,
        standardError: streams.1
      )
    }.value
  }

  // `readDataToEndOfFile` blocks until EOF, so each stream drains on its own dispatch thread
  // instead of holding a cooperative-pool thread hostage.
  private static func drain(_ pipe: Pipe) async -> Data {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        continuation.resume(returning: pipe.fileHandleForReading.readDataToEndOfFile())
      }
    }
  }
}

// `Process` is not `Sendable`, but `terminate()` is documented as safe from another thread. The
// unchecked conformance stays in this one box, and the lock makes the race explicit: either the
// deadline terminates a still-running child, or the child finishes first and the deadline is a
// no-op. Exactly one of the two wins.
private final class UpdateProcessWatchdog: @unchecked Sendable {
  private let lock = NSLock()
  private let process: Process
  private var terminated = false
  private var completed = false

  init(_ process: Process) { self.process = process }

  func arm(after timeout: Duration) -> DispatchWorkItem {
    let item = DispatchWorkItem { [self] in terminateIfRunning() }
    let seconds =
      Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + seconds, execute: item)
    return item
  }

  // Returns whether the deadline, and not the child itself, ended the run.
  func finish() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    completed = true
    return terminated
  }

  private func terminateIfRunning() {
    lock.lock()
    let shouldTerminate = !completed
    if shouldTerminate { terminated = true }
    lock.unlock()
    if shouldTerminate { process.terminate() }
  }
}
