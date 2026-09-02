import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite("Embedded runtime bootstrap")
struct EmbeddedRuntimeBootstrapTests {
  private func fixture(entrypoint: String = "bin/node") throws -> (URL, URL) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-embedded-runtime-\(UUID().uuidString)")
    let resources = root.appendingPathComponent("Resources")
    let runtime = resources.appendingPathComponent("PimpampumRuntime")
    let executable = runtime.appendingPathComponent("payload/bin/node")
    let cli = runtime.appendingPathComponent("payload/dist/cli.js")
    try FileManager.default.createDirectory(
      at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: executable.path, contents: Data("runtime".utf8))
    FileManager.default.createFile(atPath: cli.path, contents: Data("cli".utf8))
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: executable.path)
    let manifest: [String: Any] = [
      "schemaVersion": 1,
      "target": ["platform": "darwin", "architecture": "arm64"],
      "entrypoints": ["node": entrypoint, "cli": "dist/cli.js", "mcp": "dist/mcpStdio.js"],
    ]
    try JSONSerialization.data(withJSONObject: manifest).write(
      to: runtime.appendingPathComponent("runtime-manifest.json"))
    return (root, resources)
  }

  @Test("resolves only the manifest-pinned runtime inside app resources")
  func resolvesEmbeddedRuntime() throws {
    let (root, resources) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let runtime = try EmbeddedRuntimeLocator.locate(resourceURL: resources)
    #expect(runtime.executableURL.path.hasSuffix("PimpampumRuntime/payload/bin/node"))
    #expect(runtime.cliURL.path.hasSuffix("PimpampumRuntime/payload/dist/cli.js"))
  }

  @Test("rejects a manifest entrypoint that escapes the embedded payload")
  func rejectsTraversal() throws {
    let (root, resources) = try fixture(entrypoint: "../outside")
    defer { try? FileManager.default.removeItem(at: root) }
    #expect(throws: EmbeddedRuntimeLocatorError.unsafeEntrypoint) {
      try EmbeddedRuntimeLocator.locate(resourceURL: resources)
    }
  }

  @Test("rejects symlinked entrypoint components")
  func rejectsSymlinkedEntrypoint() throws {
    let (root, resources) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let runtime = resources.appendingPathComponent("PimpampumRuntime")
    let realExecutable = runtime.appendingPathComponent("payload/bin/node")
    let outside = root.appendingPathComponent("outside-node")
    try FileManager.default.moveItem(at: realExecutable, to: outside)
    try FileManager.default.createSymbolicLink(at: realExecutable, withDestinationURL: outside)
    #expect(throws: EmbeddedRuntimeLocatorError.unsafeEntrypoint) {
      try EmbeddedRuntimeLocator.locate(resourceURL: resources)
    }
  }

  @Test("rejects a symlinked runtime manifest")
  func rejectsSymlinkedManifest() throws {
    let (root, resources) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let manifest = resources.appendingPathComponent("PimpampumRuntime/runtime-manifest.json")
    let outside = root.appendingPathComponent("outside-manifest.json")
    try FileManager.default.moveItem(at: manifest, to: outside)
    try FileManager.default.createSymbolicLink(at: manifest, withDestinationURL: outside)
    #expect(throws: EmbeddedRuntimeLocatorError.invalidManifest) {
      try EmbeddedRuntimeLocator.locate(resourceURL: resources)
    }
  }

  @Test("builds argument-array setup commands and targets the stable application")
  func createsSetupInvocations() throws {
    let (root, resources) = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let bootstrap = try EmbeddedSetupBootstrap.bundled(
      resourceURL: resources,
      sourceApplicationURL: URL(fileURLWithPath: "/Volumes/Download/Pimpampum.app"),
      dataDirectory: URL(fileURLWithPath: "/Users/example/.pimpampum"),
      homeDirectory: URL(fileURLWithPath: "/Users/example")
    )
    let runtime = bootstrap.runtime
    #expect(
      bootstrap.plan(selectedConnectors: [.codex]).arguments
        == [runtime.cliURL.path, "setup", "plan", "--connector", "codex"]
    )
    #expect(
      bootstrap.apply(operationID: "operation", revision: "revision").arguments
        == [runtime.cliURL.path, "setup", "apply", "operation", "revision", "--yes"]
    )
    #expect(bootstrap.requiresInstalledApplicationRelaunch)
    // No record yet: the managed location is what the CLI will use.
    #expect(
      bootstrap.installedApplicationURL.path == "/Users/example/Applications/Pimpampum.app")
    #expect(bootstrap.installedApplication.managed)
  }

  @MainActor
  @Test("launches the recorded app before terminating a transient source copy")
  func relaunchesInstalledApplication() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-relaunch-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let home = root.appendingPathComponent("home")
    let source = root.appendingPathComponent("Downloads/Pimpampum.app")
    let installed = home.appendingPathComponent("Applications/Pimpampum.app")
    try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: installed, withIntermediateDirectories: true)
    let bootstrap = EmbeddedSetupBootstrap(
      runtime: Self.runtime(root),
      sourceApplicationURL: source,
      dataDirectory: home.appendingPathComponent(".pimpampum"),
      homeDirectory: home
    )
    let recorder = RelaunchRecorder()
    let relaunched = try await InstalledApplicationRelauncher(adapters: recorder.adapters())
      .relaunchIfNeeded(bootstrap: bootstrap)
    #expect(relaunched)
    #expect(
      recorder.launches == [
        ApplicationLaunchRequest(
          url: installed.standardizedFileURL,
          createsNewInstance: true,
          // The newcomer waits for this pid before judging its peers.
          arguments: ["--relaunched-from", "77"]
        )
      ])
    #expect(recorder.terminations == 1)
  }

  @Test("ends this process without starting a second copy when one already runs")
  @MainActor
  func terminatesWithoutLaunchingWhenInstalledCopyIsRunning() async throws {
    // Installation registers the login item by opening the installed copy, so it is normally
    // already running when setup finishes. Launching again left two icons in the menu bar;
    // skipping the terminate left two as well. Only one copy may remain.
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-relaunch-single-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let home = root.appendingPathComponent("home")
    let source = root.appendingPathComponent("Downloads/Pimpampum.app")
    let installed = home.appendingPathComponent("Applications/Pimpampum.app")
    try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: installed, withIntermediateDirectories: true)
    let bootstrap = EmbeddedSetupBootstrap(
      runtime: Self.runtime(root),
      sourceApplicationURL: source,
      dataDirectory: home.appendingPathComponent(".pimpampum"),
      homeDirectory: home
    )

    let recorder = RelaunchRecorder()
    recorder.running = true
    let relaunched = try await InstalledApplicationRelauncher(adapters: recorder.adapters())
      .relaunchIfNeeded(bootstrap: bootstrap)

    #expect(relaunched)
    #expect(recorder.launches.isEmpty)
    // The installed copy holds the menu bar, so this one must go.
    #expect(recorder.terminations == 1)
  }

  @Test("a copy already running from the installed path is left alone")
  @MainActor
  func doesNothingWhenAlreadyRunningFromTheInstalledPath() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-relaunch-noop-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let home = root.appendingPathComponent("home")
    let installed = home.appendingPathComponent("Applications/Pimpampum.app")
    try FileManager.default.createDirectory(at: installed, withIntermediateDirectories: true)
    let bootstrap = EmbeddedSetupBootstrap(
      runtime: Self.runtime(root),
      sourceApplicationURL: installed,
      dataDirectory: home.appendingPathComponent(".pimpampum"),
      homeDirectory: home
    )
    #expect(!bootstrap.requiresInstalledApplicationRelaunch)

    let recorder = RelaunchRecorder()
    recorder.running = true
    let relaunched = try await InstalledApplicationRelauncher(adapters: recorder.adapters())
      .relaunchIfNeeded(bootstrap: bootstrap)
    #expect(!relaunched)
    #expect(recorder.terminations == 0)

    // The same decision reaches the store through the command runner.
    let runner = SetupCommandRunner(bootstrap: bootstrap, relaunchAdapters: recorder.adapters())
    #expect(try await runner.relaunchInstalledApplicationIfNeeded() == false)
    #expect(runner.runsFromInstalledApplication())
  }

  @Test("a copy outside its recorded location may not register the login item")
  @MainActor
  func transientCopyDoesNotRegisterLoginItem() {
    let home = URL(fileURLWithPath: "/Users/example")
    let bootstrap = EmbeddedSetupBootstrap(
      runtime: Self.runtime(home),
      sourceApplicationURL: home.appendingPathComponent("Downloads/Pimpampum.app"),
      dataDirectory: home.appendingPathComponent(".pimpampum"),
      homeDirectory: home
    )
    #expect(!SetupCommandRunner(bootstrap: bootstrap).runsFromInstalledApplication())
  }

  @Test("does not trust a symlink at the installed application path")
  func rejectsSymlinkedInstalledApplication() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-relaunch-link-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let home = root.appendingPathComponent("home")
    let outside = root.appendingPathComponent("outside.app")
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    let installed = home.appendingPathComponent("Applications/Pimpampum.app")
    try FileManager.default.createDirectory(
      at: installed.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: installed, withDestinationURL: outside)
    let bootstrap = EmbeddedSetupBootstrap(
      runtime: Self.runtime(root),
      sourceApplicationURL: root.appendingPathComponent("Downloads/Pimpampum.app"),
      dataDirectory: home.appendingPathComponent(".pimpampum"),
      homeDirectory: home
    )
    #expect(!bootstrap.installedApplicationExists())
    // A regular file is not an application either.
    let asFile = root.appendingPathComponent("file-home")
    let fileApp = asFile.appendingPathComponent("Applications/Pimpampum.app")
    try FileManager.default.createDirectory(
      at: fileApp.deletingLastPathComponent(), withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: fileApp.path, contents: Data())
    #expect(
      !EmbeddedSetupBootstrap(
        runtime: Self.runtime(root),
        sourceApplicationURL: root.appendingPathComponent("Downloads/Pimpampum.app"),
        dataDirectory: asFile.appendingPathComponent(".pimpampum"),
        homeDirectory: asFile
      ).installedApplicationExists())
  }

  @Test("relaunches the bundle the CLI recorded, not a hardcoded managed path")
  func followsTheRecordedApplicationPath() throws {
    // With an adopted bundle in /Applications and a stale copy under ~/Applications, Done used to
    // launch the stale copy and terminate the adopted one.
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-record-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let home = root.appendingPathComponent("home")
    let dataDirectory = home.appendingPathComponent(".pimpampum")
    try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
    let adopted = root.appendingPathComponent("Applications/Pimpampum.app")
    try FileManager.default.createDirectory(at: adopted, withIntermediateDirectories: true)
    let record: [String: Any] = ["schemaVersion": 2, "path": adopted.path, "managed": false]
    try JSONSerialization.data(withJSONObject: record).write(
      to: dataDirectory.appendingPathComponent("application-path.json"))

    let fromAdopted = EmbeddedSetupBootstrap(
      runtime: Self.runtime(root),
      sourceApplicationURL: adopted,
      dataDirectory: dataDirectory,
      homeDirectory: home
    )
    #expect(!fromAdopted.requiresInstalledApplicationRelaunch)
    #expect(!fromAdopted.installedApplication.managed)

    let fromDownloads = EmbeddedSetupBootstrap(
      runtime: Self.runtime(root),
      sourceApplicationURL: root.appendingPathComponent("Downloads/Pimpampum.app"),
      dataDirectory: dataDirectory,
      homeDirectory: home
    )
    #expect(fromDownloads.requiresInstalledApplicationRelaunch)
    #expect(fromDownloads.installedApplicationURL.path == adopted.standardizedFileURL.path)
    #expect(fromDownloads.installedApplicationExists())

    // A record pointing at a bundle that no longer exists means nothing to relaunch.
    try FileManager.default.removeItem(at: adopted)
    #expect(!fromDownloads.installedApplicationExists())
  }

  private static func runtime(_ root: URL) -> EmbeddedControlRuntime {
    EmbeddedControlRuntime(
      rootURL: root,
      executableURL: root.appendingPathComponent("bin/node"),
      cliURL: root.appendingPathComponent("dist/cli.js")
    )
  }
}

@MainActor
final class RelaunchRecorder {
  var launches: [ApplicationLaunchRequest] = []
  var terminations = 0
  var running = false

  func adapters() -> ApplicationRelaunchAdapters {
    ApplicationRelaunchAdapters(
      processIdentifier: 77,
      launch: { request in self.launches.append(request) },
      terminateCurrentApplication: { self.terminations += 1 },
      isApplicationRunning: { _ in self.running }
    )
  }
}
