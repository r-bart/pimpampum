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
    #expect(
      bootstrap.installedApplicationURL.path == "/Users/example/Applications/Pimpampum.app")
  }

  @MainActor
  @Test("launches the stable app path before terminating a transient source copy")
  func relaunchesStableApplication() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-relaunch-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let home = root.appendingPathComponent("home")
    let source = root.appendingPathComponent("Downloads/Pimpampum.app")
    let installed = home.appendingPathComponent("Applications/Pimpampum.app")
    try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: installed, withIntermediateDirectories: true)
    let runtime = EmbeddedControlRuntime(
      rootURL: root,
      executableURL: root.appendingPathComponent("bin/node"),
      cliURL: root.appendingPathComponent("dist/cli.js")
    )
    let bootstrap = EmbeddedSetupBootstrap(
      runtime: runtime,
      sourceApplicationURL: source,
      homeDirectory: home
    )
    var launched: URL?
    var createsNewInstance = false
    var terminated = false
    let relaunched = try await InstalledApplicationRelauncher().relaunchIfNeeded(
      bootstrap: bootstrap,
      launchApplication: { url, configuration in
        launched = url
        createsNewInstance = configuration.createsNewApplicationInstance
      },
      terminateCurrentApplication: { terminated = true }
    )
    #expect(relaunched)
    #expect(launched == installed.standardizedFileURL)
    #expect(createsNewInstance)
    #expect(terminated)
  }

  @Test("does not trust a symlink at the stable application path")
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
      runtime: EmbeddedControlRuntime(
        rootURL: root,
        executableURL: root.appendingPathComponent("bin/node"),
        cliURL: root.appendingPathComponent("dist/cli.js")
      ),
      sourceApplicationURL: root.appendingPathComponent("Downloads/Pimpampum.app"),
      homeDirectory: home
    )
    #expect(!bootstrap.installedApplicationExists())
  }
}
