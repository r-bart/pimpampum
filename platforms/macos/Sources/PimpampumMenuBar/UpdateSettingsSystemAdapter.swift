import Foundation

// Thin `Process` adapter. It keeps stdout on a failing exit so the covered store can read the
// CLI's typed error envelope; stderr stays separate and unused, exactly like the Omarchy helper.
struct LocalUpdateCommandRunner: UpdateCommandRunning {
  func run(executable: URL, arguments: [String]) async throws -> UpdateCommandOutput {
    try await Task.detached {
      let process = Process()
      let output = Pipe()
      process.executableURL = executable
      process.arguments = arguments
      process.standardOutput = output
      // Never a Pipe: nothing reads it, so npm blocks once its warnings fill the pipe buffer and
      // stdout never reaches EOF. The store reads the CLI's envelope from stdout alone.
      process.standardError = FileHandle.nullDevice
      try process.run()
      let data = output.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return UpdateCommandOutput(exitCode: process.terminationStatus, standardOutput: data)
    }.value
  }
}
