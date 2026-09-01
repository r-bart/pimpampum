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

  /// Whether the copy that must survive setup is a different one from this process. Installation
  /// registers the login item by opening the installed copy, so by the time setup finishes there are
  /// usually two menu-bar apps running and only one may remain.
  var requiresInstalledApplicationRelaunch: Bool {
    sourceApplicationURL.resolvingSymlinksInPath().standardizedFileURL
      != installedApplicationURL.resolvingSymlinksInPath().standardizedFileURL
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
    },
    installedCopyIsRunning: @escaping (URL) -> Bool = { installedURL in
      let target = installedURL.resolvingSymlinksInPath().standardizedFileURL
      let current = ProcessInfo.processInfo.processIdentifier
      return NSWorkspace.shared.runningApplications.contains { application in
        application.processIdentifier != current
          && application.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == target
      }
    }
  ) async throws -> Bool {
    guard bootstrap.requiresInstalledApplicationRelaunch,
      bootstrap.installedApplicationExists(fileManager: fileManager)
    else { return false }
    // Two separate jobs. Starting the installed copy is only needed when nothing started it yet;
    // login-item registration usually did, several phases earlier. Ending this process is always
    // needed, because otherwise both copies keep an icon in the menu bar.
    if !installedCopyIsRunning(bootstrap.installedApplicationURL) {
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.activates = true
      // LaunchServices would otherwise focus the still-running copy in Downloads, since both apps
      // share a bundle ID.
      configuration.createsNewApplicationInstance = true
      try await launchApplication(bootstrap.installedApplicationURL, configuration)
    }
    terminateCurrentApplication()
    return true
  }
}
