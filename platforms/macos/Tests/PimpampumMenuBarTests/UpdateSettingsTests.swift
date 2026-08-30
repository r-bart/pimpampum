import Foundation
import Testing

@testable import PimpampumMenuBar

private struct UpdateReceiptReader: OverviewFileReading {
  let data: Data
  func data(at url: URL) throws -> Data { data }
}

private struct UpdateRunner: UpdateCommandRunning {
  let output: Data?
  func run(executable: URL, arguments: [String]) async throws -> Data {
    guard let output else { throw UpdateSettingsError.commandFailed }
    return output
  }
}

@Suite
@MainActor
struct UpdateSettingsTests {
  private let receipt = Data(
    #"{"schemaVersion":1,"nodePath":"/bin/sh","cliPath":"/bin/sh"}"#.utf8
  )

  @Test
  func checksAndPublishesAnAvailableUpdate() async {
    let output = Data(
      #"{"data":{"currentVersion":"1.1.0","latestVersion":"1.2.0","updateAvailable":true}}"#.utf8
    )
    let store = UpdateSettingsStore(
      receiptURL: URL(fileURLWithPath: "/receipt.json"),
      fileReader: UpdateReceiptReader(data: receipt),
      runner: UpdateRunner(output: output)
    )

    await store.check()

    #expect(store.status == DesktopUpdateStatus(
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
      updateAvailable: true
    ))
    #expect(store.errorMessage == nil)
    #expect(!store.busy)
  }

  @Test
  func reportsReceiptCommandAndResponseFailures() async {
    let unreadable = UpdateSettingsStore(
      receiptURL: URL(fileURLWithPath: "/receipt.json"),
      fileReader: UpdateReceiptReader(data: Data()),
      runner: UpdateRunner(output: nil)
    )
    await unreadable.check()
    #expect(unreadable.errorMessage == UpdateSettingsError.unavailable.message)

    let incompatibleReceipt = Data(
      #"{"schemaVersion":2,"nodePath":"/bin/sh","cliPath":"/bin/sh"}"#.utf8
    )
    let incompatible = UpdateSettingsStore(
      receiptURL: URL(fileURLWithPath: "/receipt.json"),
      fileReader: UpdateReceiptReader(data: incompatibleReceipt),
      runner: UpdateRunner(output: nil)
    )
    await incompatible.check()
    #expect(incompatible.errorMessage == UpdateSettingsError.incompatibleReceipt.message)

    let failed = UpdateSettingsStore(
      receiptURL: URL(fileURLWithPath: "/receipt.json"),
      fileReader: UpdateReceiptReader(data: receipt),
      runner: UpdateRunner(output: nil)
    )
    await failed.install()
    #expect(failed.errorMessage == UpdateSettingsError.commandFailed.message)

    let invalid = UpdateSettingsStore(
      receiptURL: URL(fileURLWithPath: "/receipt.json"),
      fileReader: UpdateReceiptReader(data: receipt),
      runner: UpdateRunner(output: Data("not-json".utf8))
    )
    await invalid.check()
    #expect(invalid.errorMessage == UpdateSettingsError.invalidResponse.message)
  }

  @Test
  func providesActionableCopyForEveryFailure() {
    #expect(!UpdateSettingsError.unavailable.message.isEmpty)
    #expect(!UpdateSettingsError.incompatibleReceipt.message.isEmpty)
    #expect(!UpdateSettingsError.commandFailed.message.isEmpty)
    #expect(!UpdateSettingsError.invalidResponse.message.isEmpty)
  }
}
