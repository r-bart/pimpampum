import Foundation

struct EmbeddedSetupBootstrap: Sendable {
  let runtime: EmbeddedControlRuntime
  let sourceApplicationURL: URL
  let dataDirectory: URL
  let homeDirectory: URL
  private let fileReader: any ApplicationConfigurationReading

  init(
    runtime: EmbeddedControlRuntime,
    sourceApplicationURL: URL,
    dataDirectory: URL,
    homeDirectory: URL,
    fileReader: any ApplicationConfigurationReading = LocalApplicationConfigurationReader()
  ) {
    self.runtime = runtime
    self.sourceApplicationURL = sourceApplicationURL.standardizedFileURL
    self.dataDirectory = dataDirectory
    self.homeDirectory = homeDirectory
    self.fileReader = fileReader
  }

  static func bundled(
    resourceURL: URL? = Bundle.main.resourceURL,
    sourceApplicationURL: URL = Bundle.main.bundleURL,
    dataDirectory: URL = ApplicationConfiguration.dataDirectory(),
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) throws -> EmbeddedSetupBootstrap {
    EmbeddedSetupBootstrap(
      runtime: try EmbeddedRuntimeLocator.locate(resourceURL: resourceURL),
      sourceApplicationURL: sourceApplicationURL,
      dataDirectory: dataDirectory,
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

  /// Where the application lives once setup is done. The CLI records it at install, and that
  /// record wins: with an adopted bundle in `/Applications` and a stale copy under
  /// `~/Applications`, relaunching the stale copy killed the real app. Before any record exists the
  /// same inference the CLI makes applies. Read on each use, because the record is written while
  /// setup runs, after this value was first needed.
  var installedApplication: ApplicationLocationRecord {
    ApplicationLocationRecord.read(
      dataDirectory: dataDirectory,
      homeDirectory: homeDirectory,
      reader: fileReader
    )
      ?? ApplicationLocationRecord.inferred(
        sourceApplicationURL: sourceApplicationURL,
        homeDirectory: homeDirectory
      )
  }

  var installedApplicationURL: URL { installedApplication.url }

  /// Whether the copy that must survive setup is a different one from this process. Installation
  /// registers the login item by opening the installed copy, so by the time setup finishes there are
  /// usually two menu-bar apps running and only one may remain.
  var requiresInstalledApplicationRelaunch: Bool {
    sourceApplicationURL.canonicalBundleURL.path != installedApplicationURL.canonicalBundleURL.path
  }

  func installedApplicationExists(fileManager: FileManager = .default) -> Bool {
    let installedApplicationURL = self.installedApplicationURL
    guard fileManager.fileExists(atPath: installedApplicationURL.path),
      let values = try? installedApplicationURL.resourceValues(forKeys: [
        .isDirectoryKey, .isSymbolicLinkKey,
      ])
    else { return false }
    return values.isDirectory == true && values.isSymbolicLink != true
  }
}

struct ApplicationLaunchRequest: Equatable, Sendable {
  let url: URL
  let createsNewInstance: Bool
  let arguments: [String]
}

/// The three system calls a relaunch needs, injected so the decision runs under test and the live
/// `NSWorkspace`/`NSApplication` calls stay in one uncovered adapter.
struct ApplicationRelaunchAdapters: Sendable {
  let processIdentifier: pid_t
  let launch: @MainActor @Sendable (ApplicationLaunchRequest) async throws -> Void
  let terminateCurrentApplication: @MainActor @Sendable () -> Void
  let isApplicationRunning: @MainActor @Sendable (URL) -> Bool
}

@MainActor
struct InstalledApplicationRelauncher {
  let adapters: ApplicationRelaunchAdapters

  func relaunchIfNeeded(
    bootstrap: EmbeddedSetupBootstrap,
    fileManager: FileManager = .default
  ) async throws -> Bool {
    guard bootstrap.requiresInstalledApplicationRelaunch,
      bootstrap.installedApplicationExists(fileManager: fileManager)
    else { return false }
    let target = bootstrap.installedApplicationURL
    // Two separate jobs. Starting the installed copy is only needed when nothing started it yet;
    // login-item registration usually did, several phases earlier. Ending this process is always
    // needed, because otherwise both copies keep an icon in the menu bar.
    if !adapters.isApplicationRunning(target) {
      try await adapters.launch(
        ApplicationLaunchRequest(
          url: target,
          // LaunchServices would otherwise focus the still-running copy in Downloads, since both
          // apps share a bundle ID.
          createsNewInstance: true,
          // The newcomer waits for this process to exit before judging its peers, so the window in
          // which both copies run cannot make it stand down.
          arguments: SingleInstancePolicy.relaunchArguments(from: adapters.processIdentifier)
        )
      )
    }
    adapters.terminateCurrentApplication()
    return true
  }
}
