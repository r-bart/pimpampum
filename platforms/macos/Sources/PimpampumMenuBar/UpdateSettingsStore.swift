import Combine
import Foundation

struct DesktopUpdateStatus: Decodable, Equatable, Sendable {
  let currentVersion: String
  let latestVersion: String
  let updateAvailable: Bool
  // Only `pimpampum update` reports it; `update:check` never changes the installation.
  let updated: Bool?
}

struct UpdateCommandOutput: Equatable, Sendable {
  let exitCode: Int32
  let standardOutput: Data
}

protocol UpdateCommandRunning: Sendable {
  func run(executable: URL, arguments: [String]) async throws -> UpdateCommandOutput
}

enum UpdateOperation: String, Equatable, Sendable {
  case check = "update:check"
  case install = "update"

  // Used only when the CLI failed without an envelope, so the notice still names the operation.
  var genericFailure: String {
    switch self {
    case .check: "Could not check for updates. Check your connection and retry."
    case .install: "Could not install the update. Check your connection and retry."
    }
  }
}

enum UpdateActivity: Equatable, Sendable {
  case idle
  case checking
  case installing

  var isBusy: Bool { self != .idle }
}

enum UpdateSettingsError: Error, Equatable {
  case unavailable
  case incompatibleReceipt
  case commandFailed(String)
  case invalidResponse

  var message: String {
    switch self {
    case .unavailable: "Pimpampum CLI is unavailable. Reinstall Pimpampum and retry."
    case .incompatibleReceipt: "The Pimpampum installation is incompatible with this app."
    case .commandFailed(let message): message
    case .invalidResponse: "Pimpampum returned an invalid update response."
    }
  }
}

// Every copy decision the Updates panel makes, so the view stays declarative and the wording
// is enforced by tests instead of by reading the SwiftUI body.
struct UpdateSettingsPresentation: Equatable, Sendable {
  let installedVersion: String?
  let latestVersion: String?
  let explanation: String
  let actionTitle: String
  let actionEnabled: Bool
  let relaunchNotice: String?
  let errorMessage: String?
}

struct DesktopUpdateEnvelope: Decodable {
  let data: DesktopUpdateStatus
}

struct DesktopUpdateFailureEnvelope: Decodable {
  struct Failure: Decodable {
    let code: String?
    let message: String
  }
  let error: Failure
}

struct DesktopUpdateReceipt: Decodable {
  let schemaVersion: Int
  let nodePath: String
  let cliPath: String
}

@MainActor
final class UpdateSettingsStore: ObservableObject {
  @Published private(set) var status: DesktopUpdateStatus?
  @Published private(set) var activity: UpdateActivity = .idle
  @Published private(set) var errorMessage: String?
  // An install rewrites the app bundle underneath the running instance, so the panel must say
  // that the new menu app only appears after the user quits and reopens this one.
  @Published private(set) var relaunchRequired = false

  var busy: Bool { activity.isBusy }

  var presentation: UpdateSettingsPresentation {
    UpdateSettingsPresentation(
      installedVersion: status?.currentVersion,
      latestVersion: status?.latestVersion,
      explanation: explanation,
      actionTitle: actionTitle,
      actionEnabled: !busy,
      relaunchNotice: relaunchRequired
        ? "Quit and reopen \(PimpampumBrand.displayName) to finish the update." : nil,
      errorMessage: errorMessage
    )
  }

  private var explanation: String {
    switch activity {
    case .checking: return "Checking npm for a newer release…"
    case .installing: return "Installing the update and reconciling the service…"
    case .idle:
      guard let status else {
        return "Check npm for a newer release. Nothing changes until you install it."
      }
      return status.updateAvailable
        ? "\(PimpampumBrand.displayName) \(status.latestVersion) is available."
        : "\(PimpampumBrand.displayName) is up to date."
    }
  }

  private var actionTitle: String {
    switch activity {
    case .checking: "Checking…"
    case .installing: "Installing…"
    case .idle: status?.updateAvailable == true ? "Install update" : "Check for updates"
    }
  }

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

  func check() async { await perform(.check) }
  func install() async { await perform(.install) }

  // The panel shows one button. The store owns which operation it runs, so the view never
  // decides between a read-only check and an installation.
  func act() async {
    if status?.updateAvailable == true {
      await install()
    } else {
      await check()
    }
  }

  private func perform(_ operation: UpdateOperation) async {
    guard !busy else { return }
    activity = operation == .check ? .checking : .installing
    errorMessage = nil
    defer { activity = .idle }
    do {
      let receipt = try loadReceipt()
      let output = try await runner.run(
        executable: URL(fileURLWithPath: receipt.nodePath),
        arguments: [receipt.cliPath, operation.rawValue]
      )
      guard output.exitCode == 0 else {
        throw UpdateSettingsError.commandFailed(
          Self.failureMessage(from: output.standardOutput, operation: operation)
        )
      }
      guard
        let envelope = try? JSONDecoder().decode(
          DesktopUpdateEnvelope.self,
          from: output.standardOutput
        )
      else { throw UpdateSettingsError.invalidResponse }
      status = envelope.data
      if operation == .install, envelope.data.updated == true { relaunchRequired = true }
    } catch let error as UpdateSettingsError {
      errorMessage = error.message
    } catch {
      errorMessage = operation.genericFailure
    }
  }

  // The CLI prints a typed envelope on stdout for local failures, so the panel shows the real
  // cause instead of a connection guess. Flattening it here would report a failed service
  // reconciliation as a network problem.
  nonisolated static func failureMessage(from output: Data, operation: UpdateOperation) -> String {
    guard
      let failure = try? JSONDecoder().decode(DesktopUpdateFailureEnvelope.self, from: output),
      !failure.error.message.isEmpty
    else { return operation.genericFailure }
    // A healthy installation ships the app and the CLI from one npm package, so the CLI always
    // knows these commands. `bad_request` means the app is newer than the CLI beside it, which
    // happens when the signed app is downloaded from Releases. Quoting "Unknown command" would
    // hand the user a fact they cannot act on; reinstalling is the repair.
    if failure.error.code == "bad_request" { return UpdateSettingsError.unavailable.message }
    return bounded(failure.error.message)
  }

  // The CLI quotes npm output in some messages, and npm output is only bounded at 1 MB. The
  // panel is the last place that text passes through, so it clamps what it renders.
  nonisolated static let maximumMessageLength = 240

  nonisolated static func bounded(_ message: String) -> String {
    message.count <= maximumMessageLength ? message : "\(message.prefix(maximumMessageLength))…"
  }

  private func loadReceipt() throws -> DesktopUpdateReceipt {
    guard
      let receipt = try? JSONDecoder().decode(
        DesktopUpdateReceipt.self,
        from: fileReader.data(at: receiptURL)
      )
    else { throw UpdateSettingsError.unavailable }
    guard receipt.schemaVersion == 1 else { throw UpdateSettingsError.incompatibleReceipt }
    guard Self.safeExecutablePath(receipt.nodePath), Self.safeExecutablePath(receipt.cliPath) else {
      throw UpdateSettingsError.unavailable
    }
    return receipt
  }

  nonisolated static func safeExecutablePath(_ path: String) -> Bool {
    NSString(string: path).isAbsolutePath && !path.contains("\0")
      && FileManager.default.isExecutableFile(atPath: path)
  }
}
