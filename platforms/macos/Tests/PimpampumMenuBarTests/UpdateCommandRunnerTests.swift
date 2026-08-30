import Foundation
import Testing

@testable import PimpampumMenuBar

// LocalUpdateCommandRunner is excluded from the coverage manifest because it only drives
// `Process`. These tests run real processes, which is the only way to prove the properties the
// covered store depends on: the exit code arrives, both streams arrive whole, and a child that
// writes heavily to one of them cannot deadlock the read of the other.
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
    #expect(output.standardError.isEmpty)
  }

  // The shape `src/cli.ts` actually produces: the typed envelope on stderr, stdout empty. Reading
  // stdout alone turned every npm refusal into "Check your connection and retry".
  @Test
  func readsTheEnvelopeTheCliWritesToStderr() async throws {
    let output = try await LocalUpdateCommandRunner().run(
      executable: shell,
      arguments: [
        "-c",
        #"printf '{"error":{"code":"unavailable","message":"Pimpampum update failed: notarget"}}' >&2; exit 1"#,
      ]
    )

    #expect(output.exitCode == 1)
    #expect(output.standardOutput.isEmpty)
    #expect(
      UpdateSettingsStore.failureMessage(from: output, operation: .install)
        == "Pimpampum update failed: notarget"
    )
  }

  @Test
  func keepsStdoutOnAFailingExitSoTheStoreCanReadTheEnvelope() async throws {
    let output = try await LocalUpdateCommandRunner().run(
      executable: shell,
      arguments: ["-c", #"printf '{"error":{"message":"boom"}}'; exit 1"#]
    )

    #expect(output.exitCode == 1)
    #expect(UpdateSettingsStore.failureMessage(from: output, operation: .install) == "boom")
  }

  // An unread pipe fills after roughly 64 KB and the child blocks on write. Each of these asks for
  // 1 MB on one stream while the answer arrives on the other, so the test hangs until the time
  // limit if the adapter ever stops draining both pipes at the same time.
  @Test(.timeLimit(.minutes(1)))
  func survivesAChildThatFloodsStderr() async throws {
    let output = try await LocalUpdateCommandRunner().run(
      executable: shell,
      arguments: [
        "-c",
        #"i=0; while [ $i -lt 16384 ]; do printf 'npm warn deprecated padding padding pad\n' >&2; i=$((i+1)); done; printf '{"data":{"currentVersion":"1.1.0","latestVersion":"1.1.0","updateAvailable":false}}'"#,
      ]
    )

    #expect(output.exitCode == 0)
    #expect(output.standardError.count == 655_360)
    #expect(
      String(decoding: output.standardOutput, as: UTF8.self)
        == #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.1.0","updateAvailable":false}}"#
    )
  }

  @Test(.timeLimit(.minutes(1)))
  func survivesAChildThatFloodsStdout() async throws {
    let output = try await LocalUpdateCommandRunner().run(
      executable: shell,
      arguments: [
        "-c",
        #"i=0; while [ $i -lt 16384 ]; do printf 'progress progress progress progress pad\n'; i=$((i+1)); done; printf '{"error":{"message":"drowned but heard"}}' >&2; exit 1"#,
      ]
    )

    #expect(output.exitCode == 1)
    #expect(output.standardOutput.count == 655_360)
    #expect(
      UpdateSettingsStore.failureMessage(from: output, operation: .check) == "drowned but heard"
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
