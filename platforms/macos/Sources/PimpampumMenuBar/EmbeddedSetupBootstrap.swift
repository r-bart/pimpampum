import AppKit
import Foundation

struct EmbeddedSetupBootstrap: Sendable {
  let runtime: EmbeddedControlRuntime
  let sourceApplicationURL: URL
  let installedApplicationURL: URL

  init(
    runtime: EmbeddedControlRuntime,
    sourceApplicationURL: URL = Bundle.main.bundleURL,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) {
    self.runtime = runtime
    self.sourceApplicationURL = sourceApplicationURL.standardizedFileURL
    self.installedApplicationURL =
      homeDirectory
      .appendingPathComponent("Applications", isDirectory: true)
      .appendingPathComponent("Pimpampum.app", isDirectory: true)
      .standardizedFileURL
  }

  static func bundled(
    resourceURL: URL? = Bundle.main.resourceURL,
    sourceApplicationURL: URL = Bundle.main.bundleURL,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) throws -> EmbeddedSetupBootstrap {
    EmbeddedSetupBootstrap(
      runtime: try EmbeddedRuntimeLocator.locate(resourceURL: resourceURL),
      sourceApplicationURL: sourceApplicationURL,
      homeDirectory: homeDirectory
    )
  }

  func plan(selectedConnectors: [SetupAgentID]) -> EmbeddedRuntimeInvocation {
    let connectorArguments = selectedConnectors.flatMap { ["--connector", $0.rawValue] }
    return runtime.invocation(arguments: ["setup", "plan"] + connectorArguments)
  }

  func apply(
    operationID: String,
    revision: String,
    replacing connectors: [SetupAgentID] = []
  ) -> EmbeddedRuntimeInvocation {
    let replacementArguments = connectors.flatMap { ["--replace", $0.rawValue] }
    return runtime.invocation(
      arguments: ["setup", "apply", operationID, revision, "--yes"] + replacementArguments
    )
  }

  var requiresInstalledApplicationRelaunch: Bool {
    sourceApplicationURL.resolvingSymlinksInPath()
      != installedApplicationURL.resolvingSymlinksInPath()
  }

  func installedApplicationExists(fileManager: FileManager = .default) -> Bool {
    guard fileManager.fileExists(atPath: installedApplicationURL.path),
      let values = try? installedApplicationURL.resourceValues(forKeys: [
        .isDirectoryKey, .isSymbolicLinkKey,
      ])
    else { return false }
    return values.isDirectory == true && values.isSymbolicLink != true
  }
}

@MainActor
struct InstalledApplicationRelauncher {
  func relaunchIfNeeded(
    bootstrap: EmbeddedSetupBootstrap,
    fileManager: FileManager = .default,
    launchApplication: @escaping (URL, NSWorkspace.OpenConfiguration) async throws -> Void = {
      url, configuration in
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, any Error>) in
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: ())
          }
        }
      }
    },
    terminateCurrentApplication: @escaping () -> Void = {
      NSApplication.shared.terminate(nil)
    }
  ) async throws -> Bool {
    guard bootstrap.requiresInstalledApplicationRelaunch,
      bootstrap.installedApplicationExists(fileManager: fileManager)
    else { return false }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    // LaunchServices may otherwise focus the still-running copy in Downloads because both apps
    // share a bundle ID. Start the stable path before terminating this transient source process.
    configuration.createsNewApplicationInstance = true
    try await launchApplication(bootstrap.installedApplicationURL, configuration)
    terminateCurrentApplication()
    return true
  }
}
