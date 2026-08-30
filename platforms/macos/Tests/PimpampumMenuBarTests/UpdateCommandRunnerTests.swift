import Foundation
import Testing

@testable import PimpampumMenuBar

// LocalUpdateCommandRunner is excluded from the coverage manifest because it only drives
// `Process`. These tests run real processes, which is the only way to prove the properties the
// covered store depends on: the exit code arrives, stdout arrives whole, and a child that writes
// heavily to the stream we ignore cannot deadlock the read.
@Suite
struct UpdateCommandRunnerTests {
  private let shell = URL(fileURLWithPath: "/bin/sh")

  @Test
  func returnsStdoutAndASuccessfulExitCode() async throws {
    let output = try await LocalUpdateCommandRunner().run(
      executable: shell,
      arguments: ["-c", #"printf '{"data":{"updateAvailable":false}}'"#]
    )

    #expect(output.exitCode == 0)
    #expect(
      String(decoding: output.standardOutput, as: UTF8.self)
        == #"{"data":{"updateAvailable":false}}"#
    )
  }

  @Test
  func keepsStdoutOnAFailingExitSoTheStoreCanReadTheEnvelope() async throws {
    let output = try await LocalUpdateCommandRunner().run(
      executable: shell,
      arguments: ["-c", #"printf '{"error":{"message":"boom"}}'; exit 1"#]
    )

    #expect(output.exitCode == 1)
    #expect(
      UpdateSettingsStore.failureMessage(from: output.standardOutput, operation: .install) == "boom"
    )
  }

  // npm writes its warnings to stderr. An unread `Pipe` fills after roughly 64 KB, the child
  // blocks on write, and stdout never reaches EOF. This asks for 1 MB, so the test hangs until
  // the time limit if the adapter ever goes back to piping a stream nobody drains.
  @Test(.timeLimit(.minutes(1)))
  func survivesAChildThatFloodsTheIgnoredStream() async throws {
    let output = try await LocalUpdateCommandRunner().run(
      executable: shell,
      arguments: [
        "-c",
        #"i=0; while [ $i -lt 16384 ]; do printf 'npm warn deprecated padding padding pad\n' >&2; i=$((i+1)); done; printf '{"data":{"currentVersion":"1.1.0","latestVersion":"1.1.0","updateAvailable":false}}'"#,
      ]
    )

    #expect(output.exitCode == 0)
    #expect(
      String(decoding: output.standardOutput, as: UTF8.self)
        == #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.1.0","updateAvailable":false}}"#
    )
  }

  @Test
  func throwsWhenTheReceiptPointsAtSomethingItCannotRun() async {
    await #expect(throws: (any Error).self) {
      try await LocalUpdateCommandRunner().run(
        executable: URL(fileURLWithPath: "/nonexistent/pimpampum-node"),
        arguments: []
      )
    }
  }
}
