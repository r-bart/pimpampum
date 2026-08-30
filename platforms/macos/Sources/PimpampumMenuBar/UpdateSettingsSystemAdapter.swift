import Foundation

// Thin `Process` adapter. It returns both streams on every exit: `src/cli.ts` writes success data
// to stdout and its typed error envelope to stderr, so the covered store needs both to tell a real
// cause from a guess.
struct LocalUpdateCommandRunner: UpdateCommandRunning {
  func run(executable: URL, arguments: [String]) async throws -> UpdateCommandOutput {
    try await Task.detached {
      let process = Process()
      let output = Pipe()
      let failure = Pipe()
      process.executableURL = executable
      process.arguments = arguments
      process.standardOutput = output
      process.standardError = failure
      try process.run()
      // Both pipes drain at the same time. Reading one to EOF before starting the other lets the
      // child block once it fills the buffer of the stream nobody is draining, and then the read
      // that is waiting never reaches EOF either.
      async let standardOutput = Self.drain(output)
      async let standardError = Self.drain(failure)
      let streams = await (standardOutput, standardError)
      process.waitUntilExit()
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
