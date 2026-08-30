import Foundation
import SwiftUI

struct DesktopUpdateStatus: Decodable, Equatable, Sendable {
  let currentVersion: String
  let latestVersion: String
  let updateAvailable: Bool
}

private struct DesktopUpdateEnvelope: Decodable { let data: DesktopUpdateStatus }
private struct DesktopUpdateReceipt: Decodable {
  let schemaVersion: Int
  let nodePath: String
  let cliPath: String
}

protocol UpdateCommandRunning: Sendable {
  func run(executable: URL, arguments: [String]) async throws -> Data
}

struct LocalUpdateCommandRunner: UpdateCommandRunning {
  func run(executable: URL, arguments: [String]) async throws -> Data {
    try await Task.detached {
      let process = Process()
      let output = Pipe()
      process.executableURL = executable
      process.arguments = arguments
      process.standardOutput = output
      process.standardError = Pipe()
      try process.run()
      process.waitUntilExit()
      let data = output.fileHandleForReading.readDataToEndOfFile()
      guard process.terminationStatus == 0 else { throw UpdateSettingsError.commandFailed }
      return data
    }.value
  }
}

enum UpdateSettingsError: Error, Equatable {
  case unavailable
  case incompatibleReceipt
  case commandFailed
  case invalidResponse

  var message: String {
    switch self {
    case .unavailable: "Pimpampum CLI is unavailable. Reinstall Pimpampum and retry."
    case .incompatibleReceipt: "The Pimpampum installation is incompatible with this app."
    case .commandFailed: "Could not check for updates. Check your connection and retry."
    case .invalidResponse: "Pimpampum returned an invalid update response."
    }
  }
}

@MainActor
final class UpdateSettingsStore: ObservableObject {
  @Published private(set) var status: DesktopUpdateStatus?
  @Published private(set) var busy = false
  @Published private(set) var errorMessage: String?

  private let receiptURL: URL
  private let fileReader: any OverviewFileReading
  private let runner: any UpdateCommandRunning

  init(
    receiptURL: URL,
    fileReader: any OverviewFileReading = LocalOverviewFileReader(),
    runner: any UpdateCommandRunning = LocalUpdateCommandRunner()
  ) {
    self.receiptURL = receiptURL
    self.fileReader = fileReader
    self.runner = runner
  }

  func check() async { await perform(command: "update:check") }
  func install() async { await perform(command: "update") }

  private func perform(command: String) async {
    guard !busy else { return }
    busy = true
    errorMessage = nil
    defer { busy = false }
    do {
      let receipt = try loadReceipt()
      let output = try await runner.run(
        executable: URL(fileURLWithPath: receipt.nodePath),
        arguments: [receipt.cliPath, command]
      )
      status = try JSONDecoder().decode(DesktopUpdateEnvelope.self, from: output).data
    } catch let error as UpdateSettingsError {
      errorMessage = error.message
    } catch {
      errorMessage = UpdateSettingsError.invalidResponse.message
    }
  }

  private func loadReceipt() throws -> DesktopUpdateReceipt {
    guard let receipt = try? JSONDecoder().decode(
      DesktopUpdateReceipt.self,
      from: fileReader.data(at: receiptURL)
    ) else { throw UpdateSettingsError.unavailable }
    guard receipt.schemaVersion == 1 else { throw UpdateSettingsError.incompatibleReceipt }
    guard safeExecutablePath(receipt.nodePath), safeExecutablePath(receipt.cliPath) else {
      throw UpdateSettingsError.unavailable
    }
    return receipt
  }

  private func safeExecutablePath(_ path: String) -> Bool {
    NSString(string: path).isAbsolutePath && !path.contains("\0")
      && FileManager.default.isExecutableFile(atPath: path)
  }
}

@MainActor
struct UpdateSettingsView: View {
  @ObservedObject var store: UpdateSettingsStore

  var body: some View {
    Form {
      Section("Updates") {
        if let status = store.status {
          LabeledContent("Installed", value: status.currentVersion)
          LabeledContent("Latest", value: status.latestVersion)
          Text(status.updateAvailable ? "A newer version is available." : "Pimpampum is up to date.")
            .foregroundStyle(.secondary)
        } else {
          Text("Check npm for a newer release. Nothing changes until you install it.")
            .foregroundStyle(.secondary)
        }
        if let errorMessage = store.errorMessage {
          Label(errorMessage, systemImage: "exclamationmark.triangle")
            .foregroundStyle(.red)
        }
        Button(store.status?.updateAvailable == true ? "Install update" : "Check for updates") {
          Task {
            if store.status?.updateAvailable == true { await store.install() }
            else { await store.check() }
          }
        }
        .disabled(store.busy)
      }
    }
    .formStyle(.grouped)
    .overlay { if store.busy { ProgressView() } }
  }
}
