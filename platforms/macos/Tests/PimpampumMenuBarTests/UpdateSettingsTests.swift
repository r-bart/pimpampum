import Foundation
import Testing

@testable import PimpampumMenuBar

private struct UpdateReceiptReader: OverviewFileReading {
  let data: Data
  func data(at url: URL) throws -> Data { data }
}

private struct FailingReceiptReader: OverviewFileReading {
  func data(at url: URL) throws -> Data { throw CocoaError(.fileReadNoSuchFile) }
}

private struct UpdateRunner: UpdateCommandRunning {
  let output: UpdateCommandOutput
  func run(executable: URL, arguments: [String], timeout: Duration?) async throws
    -> UpdateCommandOutput { output }
}

private struct FailingRunner: UpdateCommandRunning {
  func run(executable: URL, arguments: [String], timeout: Duration?) async throws
    -> UpdateCommandOutput {
    throw CocoaError(.fileNoSuchFile)
  }
}

private struct TimingOutRunner: UpdateCommandRunning {
  func run(executable: URL, arguments: [String], timeout: Duration?) async throws
    -> UpdateCommandOutput {
    throw UpdateSettingsError.timedOut
  }
}

private actor DeadlineLog {
  private(set) var deadlines: [Duration?] = []
  func record(_ timeout: Duration?) { deadlines.append(timeout) }
}

private struct RecordingRunner: UpdateCommandRunning {
  let log: DeadlineLog
  let output: UpdateCommandOutput
  func run(executable: URL, arguments: [String], timeout: Duration?) async throws
    -> UpdateCommandOutput {
    await log.record(timeout)
    return output
  }
}

private actor RunnerGate {
  private var continuation: CheckedContinuation<Void, Never>?
  private var opened = false

  func wait() async {
    if opened { return }
    await withCheckedContinuation { self.continuation = $0 }
  }

  func open() {
    opened = true
    continuation?.resume()
    continuation = nil
  }
}

private struct GatedRunner: UpdateCommandRunning {
  let gate: RunnerGate
  let output: UpdateCommandOutput
  func run(executable: URL, arguments: [String], timeout: Duration?) async throws
    -> UpdateCommandOutput {
    await gate.wait()
    return output
  }
}

private struct ScriptedRunner: UpdateCommandRunning {
  let gate: RunnerGate
  let checked: UpdateCommandOutput
  let installed: UpdateCommandOutput
  func run(executable: URL, arguments: [String], timeout: Duration?) async throws
    -> UpdateCommandOutput {
    guard arguments.last == UpdateOperation.install.rawValue else { return checked }
    await gate.wait()
    return installed
  }
}

@MainActor
private func settle(until reached: () -> Bool) async {
  var attempts = 0
  while !reached(), attempts < 10_000 {
    await Task.yield()
    attempts += 1
  }
}

private func succeeded(_ json: String) -> UpdateCommandOutput {
  UpdateCommandOutput(exitCode: 0, standardOutput: Data(json.utf8))
}

// The CLI writes its typed envelope to stderr and leaves stdout empty on a failure. Building this
// fixture the other way round is exactly what let a panel that only read stdout reach a release.
private func failed(_ json: String) -> UpdateCommandOutput {
  UpdateCommandOutput(exitCode: 1, standardOutput: Data(), standardError: Data(json.utf8))
}

private func failedOnStandardOutput(_ json: String) -> UpdateCommandOutput {
  UpdateCommandOutput(exitCode: 1, standardOutput: Data(json.utf8))
}

@Suite
@MainActor
struct UpdateSettingsTests {
  private let receipt = Data(
    #"{"schemaVersion":1,"nodePath":"/bin/sh","cliPath":"/bin/sh"}"#.utf8
  )

  private func store(
    receipt: Data,
    runner: any UpdateCommandRunning
  ) -> UpdateSettingsStore {
    UpdateSettingsStore(
      receiptURL: URL(fileURLWithPath: "/receipt.json"),
      fileReader: UpdateReceiptReader(data: receipt),
      runner: runner
    )
  }

  private func store(_ runner: any UpdateCommandRunning) -> UpdateSettingsStore {
    store(receipt: receipt, runner: runner)
  }

  @Test
  func checksAndPublishesAnAvailableUpdateWithoutTouchingTheInstallation() async {
    let checked = store(
      UpdateRunner(
        output: succeeded(
          #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.2.0","updateAvailable":true}}"#
        )
      )
    )

    await checked.check()

    #expect(
      checked.status
        == DesktopUpdateStatus(
          currentVersion: "1.1.0",
          latestVersion: "1.2.0",
          updateAvailable: true,
          updated: nil
        )
    )
    #expect(checked.errorMessage == nil)
    #expect(checked.activity == .idle)
    #expect(!checked.busy)
    #expect(!checked.relaunchRequired)
  }

  @Test
  func asksForARelaunchOnlyWhenTheInstallReplacedTheRelease() async {
    let replaced = store(
      UpdateRunner(
        output: succeeded(
          #"{"data":{"currentVersion":"1.2.0","latestVersion":"1.2.0","updateAvailable":false,"updated":true}}"#
        )
      )
    )
    await replaced.install()
    #expect(replaced.relaunchRequired)
    #expect(replaced.status?.updated == true)

    let alreadyCurrent = store(
      UpdateRunner(
        output: succeeded(
          #"{"data":{"currentVersion":"1.2.0","latestVersion":"1.2.0","updateAvailable":false,"updated":false}}"#
        )
      )
    )
    await alreadyCurrent.install()
    #expect(!alreadyCurrent.relaunchRequired)

    let checkedOnly = store(
      UpdateRunner(
        output: succeeded(
          #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.2.0","updateAvailable":true}}"#
        )
      )
    )
    await checkedOnly.check()
    #expect(!checkedOnly.relaunchRequired)
  }

  @Test
  func surfacesTheCliFailureEnvelopeInsteadOfAConnectionGuess() async {
    let reconciliation = store(
      UpdateRunner(
        output: failed(
          #"{"error":{"code":"unavailable","message":"Pimpampum updated but service reconciliation failed"}}"#
        )
      )
    )

    await reconciliation.install()

    #expect(reconciliation.errorMessage == "Pimpampum updated but service reconciliation failed")
    #expect(reconciliation.status == nil)
    #expect(!reconciliation.relaunchRequired)
  }

  // The refusal a real machine produced: npm declined 1.1.1 under a minimum-release-age policy and
  // the panel answered "Could not install the update. Check your connection and retry." because it
  // read stdout, which the CLI leaves empty on a failure.
  @Test
  func quotesTheNpmRefusalTheCliReportsOnStderr() async {
    let policy = store(
      UpdateRunner(
        output: failed(
          #"{"error":{"code":"unavailable","message":"Pimpampum update failed: notarget No matching version found for pimpampum@1.1.1 with a date before 8/23/2026, 2:42:25 PM."}}"#
        )
      )
    )

    await policy.install()

    #expect(
      policy.errorMessage
        == "Pimpampum update failed: notarget No matching version found for pimpampum@1.1.1 with a date before 8/23/2026, 2:42:25 PM."
    )
    #expect(policy.errorMessage != UpdateOperation.install.genericFailure)
  }

  // Both streams are read, so moving the envelope back to stdout would not silently blind the panel.
  @Test
  func stillReadsAnEnvelopeThatArrivesOnStandardOutput() async {
    let legacy = store(
      UpdateRunner(output: failedOnStandardOutput(#"{"error":{"message":"from stdout"}}"#))
    )

    await legacy.check()

    #expect(legacy.errorMessage == "from stdout")
  }

  @Test
  func namesTheOperationWhenTheCliFailsWithoutAUsableEnvelope() async {
    let unparsable = store(UpdateRunner(output: failed("npm exploded")))
    await unparsable.check()
    #expect(unparsable.errorMessage == UpdateOperation.check.genericFailure)

    let empty = store(UpdateRunner(output: failed(#"{"error":{"message":""}}"#)))
    await empty.install()
    #expect(empty.errorMessage == UpdateOperation.install.genericFailure)

    let unreachable = store(FailingRunner())
    await unreachable.check()
    #expect(unreachable.errorMessage == UpdateOperation.check.genericFailure)
    #expect(UpdateOperation.check.genericFailure != UpdateOperation.install.genericFailure)
  }

  @Test
  func rejectsAReceiptItCannotTrust() async {
    let unreadable = store(receipt: Data(), runner: UpdateRunner(output: succeeded("{}")))
    await unreadable.check()
    #expect(unreadable.errorMessage == UpdateSettingsError.unavailable.message)

    let unopenable = UpdateSettingsStore(
      receiptURL: URL(fileURLWithPath: "/receipt.json"),
      fileReader: FailingReceiptReader(),
      runner: UpdateRunner(output: succeeded("{}"))
    )
    await unopenable.check()
    #expect(unopenable.errorMessage == UpdateSettingsError.unavailable.message)

    let incompatible = store(
      receipt: Data(#"{"schemaVersion":2,"nodePath":"/bin/sh","cliPath":"/bin/sh"}"#.utf8),
      runner: UpdateRunner(output: succeeded("{}"))
    )
    await incompatible.check()
    #expect(incompatible.errorMessage == UpdateSettingsError.incompatibleReceipt.message)

    let relative = store(
      receipt: Data(#"{"schemaVersion":1,"nodePath":"bin/sh","cliPath":"/bin/sh"}"#.utf8),
      runner: UpdateRunner(output: succeeded("{}"))
    )
    await relative.check()
    #expect(relative.errorMessage == UpdateSettingsError.unavailable.message)

    let notExecutable = store(
      receipt: Data(#"{"schemaVersion":1,"nodePath":"/bin/sh","cliPath":"/etc/hosts"}"#.utf8),
      runner: UpdateRunner(output: succeeded("{}"))
    )
    await notExecutable.check()
    #expect(notExecutable.errorMessage == UpdateSettingsError.unavailable.message)
  }

  @Test
  func rejectsAPathThatSmugglesANullByte() {
    #expect(UpdateSettingsStore.safeExecutablePath("/bin/sh"))
    #expect(!UpdateSettingsStore.safeExecutablePath("bin/sh"))
    #expect(!UpdateSettingsStore.safeExecutablePath("/bin/\u{0}sh"))
    #expect(!UpdateSettingsStore.safeExecutablePath("/etc/hosts"))
  }

  @Test
  func rejectsASuccessfulRunThatIsNotAPimpampumEnvelope() async {
    let invalid = store(UpdateRunner(output: succeeded("not-json")))
    await invalid.check()
    #expect(invalid.errorMessage == UpdateSettingsError.invalidResponse.message)
    #expect(invalid.status == nil)
  }

  @Test
  func ignoresACompetingRequestWhileOneIsRunning() async {
    let gate = RunnerGate()
    let running = store(
      GatedRunner(
        gate: gate,
        output: succeeded(
          #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.1.0","updateAvailable":false}}"#
        )
      )
    )

    let first = Task { await running.check() }
    await settle(until: { running.busy })
    #expect(running.activity == .checking)

    await running.install()
    #expect(running.activity == .checking)
    #expect(running.status == nil)

    await gate.open()
    await first.value
    #expect(running.activity == .idle)
    #expect(running.status?.updateAvailable == false)
  }

  @Test
  func presentsEveryPanelStateWithItsOwnCopy() async {
    let idle = store(UpdateRunner(output: succeeded("{}")))
    #expect(
      idle.presentation
        == UpdateSettingsPresentation(
          installedVersion: nil,
          latestVersion: nil,
          explanation: "Check npm for a newer release. Nothing changes until you install it.",
          actionTitle: "Check for updates",
          actionEnabled: true,
          relaunchNotice: nil,
          errorMessage: nil
        )
    )

    let available = store(
      UpdateRunner(
        output: succeeded(
          #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.2.0","updateAvailable":true}}"#
        )
      )
    )
    await available.check()
    #expect(available.presentation.actionTitle == "Install update")
    #expect(
      available.presentation.explanation == "\(PimpampumBrand.displayName) 1.2.0 is available."
    )
    #expect(available.presentation.installedVersion == "1.1.0")
    #expect(available.presentation.latestVersion == "1.2.0")

    let current = store(
      UpdateRunner(
        output: succeeded(
          #"{"data":{"currentVersion":"1.2.0","latestVersion":"1.2.0","updateAvailable":false}}"#
        )
      )
    )
    await current.check()
    #expect(current.presentation.explanation == "\(PimpampumBrand.displayName) is up to date.")
    #expect(current.presentation.actionTitle == "Check for updates")

    let installed = store(
      UpdateRunner(
        output: succeeded(
          #"{"data":{"currentVersion":"1.2.0","latestVersion":"1.2.0","updateAvailable":false,"updated":true}}"#
        )
      )
    )
    await installed.install()
    #expect(
      installed.presentation.relaunchNotice
        == "Quit and reopen \(PimpampumBrand.displayName) to finish the update."
    )

    let failing = store(UpdateRunner(output: failed("npm exploded")))
    await failing.check()
    #expect(failing.presentation.errorMessage == UpdateOperation.check.genericFailure)
  }

  @Test
  func namesTheRunningOperationWhileItIsBusy() async {
    let gate = RunnerGate()
    let running = store(
      GatedRunner(
        gate: gate,
        output: succeeded(
          #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.2.0","updateAvailable":true}}"#
        )
      )
    )

    let checking = Task { await running.act() }
    await settle(until: { running.busy })
    #expect(running.presentation.actionTitle == "Checking…")
    #expect(running.presentation.explanation == "Checking npm for a newer release…")
    #expect(!running.presentation.actionEnabled)
    await gate.open()
    await checking.value

    let installGate = RunnerGate()
    let installing = store(
      ScriptedRunner(
        gate: installGate,
        checked: succeeded(
          #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.2.0","updateAvailable":true}}"#
        ),
        installed: succeeded(
          #"{"data":{"currentVersion":"1.2.0","latestVersion":"1.2.0","updateAvailable":false,"updated":true}}"#
        )
      )
    )
    await installing.check()
    // `act` installs once a check reported an available release.
    let install = Task { await installing.act() }
    await settle(until: { installing.activity == .installing })
    #expect(installing.presentation.actionTitle == "Installing…")
    #expect(
      installing.presentation.explanation == "Installing the update and reconciling the service…"
    )
    await installGate.open()
    await install.value
    #expect(installing.relaunchRequired)
  }

  @Test
  func clampsALongFailureMessageBeforeItReachesThePanel() async {
    let long = String(repeating: "x", count: UpdateSettingsStore.maximumMessageLength + 40)
    let shouted = store(UpdateRunner(output: failed(#"{"error":{"message":"\#(long)"}}"#)))

    await shouted.check()

    #expect(shouted.errorMessage?.count == UpdateSettingsStore.maximumMessageLength + 1)
    #expect(shouted.errorMessage?.hasSuffix("…") == true)
    #expect(UpdateSettingsStore.bounded("short") == "short")
    // npm text arrives with newlines, and the panel renders one line.
    #expect(UpdateSettingsStore.bounded("two\n\tlines  here") == "two lines here")
  }

  @Test
  func tellsTheUserToReinstallWhenTheCliIsOlderThanTheApp() async {
    // Exactly what a 1.0.0 CLI answers a 1.1.0 app downloaded from GitHub Releases.
    let stale = store(
      UpdateRunner(
        output: failed(
          #"{"error":{"code":"bad_request","message":"Unknown command: update:check"}}"#
        )
      )
    )

    await stale.check()

    #expect(stale.errorMessage == UpdateSettingsError.unavailable.message)
  }

  @Test
  func composesTheNativePanel() {
    _ = UpdateSettingsView(store: store(UpdateRunner(output: succeeded("{}")))).body
  }

  @Test
  func providesActionableCopyForEveryFailure() {
    #expect(!UpdateSettingsError.unavailable.message.isEmpty)
    #expect(!UpdateSettingsError.incompatibleReceipt.message.isEmpty)
    #expect(!UpdateSettingsError.commandFailed("boom").message.isEmpty)
    #expect(UpdateSettingsError.commandFailed("boom").message == "boom")
    #expect(!UpdateSettingsError.invalidResponse.message.isEmpty)
    #expect(UpdateSettingsError.unavailable != UpdateSettingsError.invalidResponse)
    #expect(UpdateOperation.check.rawValue == "update:check")
    #expect(UpdateOperation.install.rawValue == "update")
    #expect(!UpdateActivity.idle.isBusy)
    #expect(UpdateActivity.checking.isBusy)
    #expect(UpdateActivity.installing.isBusy)
  }

  @Test
  func comparesEveryFieldOfAPublishedStatus() {
    let status = DesktopUpdateStatus(
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
      updateAvailable: true,
      updated: nil
    )
    #expect(status == status)
    #expect(
      status
        != DesktopUpdateStatus(
          currentVersion: "1.0.0",
          latestVersion: "1.2.0",
          updateAvailable: true,
          updated: nil
        )
    )
    #expect(
      status
        != DesktopUpdateStatus(
          currentVersion: "1.1.0",
          latestVersion: "1.3.0",
          updateAvailable: true,
          updated: nil
        )
    )
    #expect(
      status
        != DesktopUpdateStatus(
          currentVersion: "1.1.0",
          latestVersion: "1.2.0",
          updateAvailable: false,
          updated: nil
        )
    )
    #expect(
      status
        != DesktopUpdateStatus(
          currentVersion: "1.1.0",
          latestVersion: "1.2.0",
          updateAvailable: true,
          updated: true
        )
    )
    #expect(
      UpdateCommandOutput(exitCode: 0, standardOutput: Data())
        != UpdateCommandOutput(exitCode: 1, standardOutput: Data())
    )
  }

  // Only the read-only check carries a deadline. An install that npm has already started is worse
  // to kill than to wait for, so it runs unbounded.
  @Test
  func boundsTheCheckAndLeavesTheInstallUnbounded() async {
    #expect(UpdateOperation.check.timeout == .seconds(90))
    #expect(UpdateOperation.install.timeout == nil)

    let log = DeadlineLog()
    let checked = store(
      RecordingRunner(
        log: log,
        output: succeeded(
          #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.2.0","updateAvailable":true}}"#
        )
      )
    )

    await checked.check()
    await checked.install()

    #expect(await log.deadlines == [.seconds(90), nil])
  }

  // A hung check used to leave the panel disabled until the app restarted. The store reports the
  // expiry as its own cause and returns the button to the user.
  @Test
  func reportsAnExpiredDeadlineAndReleasesTheButton() async {
    let timedOut = store(TimingOutRunner())

    await timedOut.check()

    #expect(
      timedOut.presentation.errorMessage
        == "The update check took too long. Retry when the network responds."
    )
    #expect(timedOut.presentation.actionEnabled)
    #expect(timedOut.activity == .idle)
  }
}
