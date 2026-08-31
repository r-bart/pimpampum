import Foundation

struct EmbeddedControlRuntime: Equatable, Sendable {
  let rootURL: URL
  let executableURL: URL
  let cliURL: URL

  func invocation(arguments: [String]) -> EmbeddedRuntimeInvocation {
    EmbeddedRuntimeInvocation(
      executableURL: executableURL,
      arguments: [cliURL.path] + arguments
    )
  }
}

struct EmbeddedRuntimeInvocation: Equatable, Sendable {
  let executableURL: URL
  let arguments: [String]
}

enum EmbeddedRuntimeLocatorError: Error, Equatable {
  case missingResources
  case invalidManifest
  case unsupportedTarget
  case unsafeEntrypoint
  case missingEntrypoint
}

private struct EmbeddedRuntimeManifest: Decodable {
  struct Target: Decodable {
    let platform: String
    let architecture: String
  }

  struct Entrypoints: Decodable {
    let node: String
    let cli: String
  }

  let schemaVersion: Int
  let target: Target
  let entrypoints: Entrypoints
}

enum EmbeddedRuntimeLocator {
  static let runtimeResourceName = "PimpampumRuntime"
  private static let maximumManifestBytes = 1_048_576

  static func locate(
    resourceURL: URL? = Bundle.main.resourceURL,
    fileManager: FileManager = .default
  ) throws -> EmbeddedControlRuntime {
    guard let resourceURL else { throw EmbeddedRuntimeLocatorError.missingResources }
    let root = resourceURL.appendingPathComponent(runtimeResourceName, isDirectory: true)
      .standardizedFileURL
    guard regularDirectory(root) else { throw EmbeddedRuntimeLocatorError.missingResources }
    let manifestURL = root.appendingPathComponent("runtime-manifest.json")
    guard regularFile(manifestURL, fileManager: fileManager) else {
      throw EmbeddedRuntimeLocatorError.invalidManifest
    }
    let manifestData: Data
    do {
      let handle = try FileHandle(forReadingFrom: manifestURL)
      defer { try? handle.close() }
      manifestData = try handle.read(upToCount: maximumManifestBytes + 1) ?? Data()
    } catch {
      throw EmbeddedRuntimeLocatorError.invalidManifest
    }
    guard manifestData.count <= maximumManifestBytes,
      let manifest = try? JSONDecoder().decode(EmbeddedRuntimeManifest.self, from: manifestData),
      manifest.schemaVersion == 1
    else { throw EmbeddedRuntimeLocatorError.invalidManifest }
    guard manifest.target.platform == "darwin", manifest.target.architecture == "arm64" else {
      throw EmbeddedRuntimeLocatorError.unsupportedTarget
    }

    let payload = root.appendingPathComponent("payload", isDirectory: true)
      .standardizedFileURL
    guard regularDirectory(payload) else { throw EmbeddedRuntimeLocatorError.missingEntrypoint }
    let executableURL = try entrypoint(manifest.entrypoints.node, payload: payload)
    let cliURL = try entrypoint(manifest.entrypoints.cli, payload: payload)
    guard regularFile(executableURL, fileManager: fileManager),
      fileManager.isExecutableFile(atPath: executableURL.path),
      regularFile(cliURL, fileManager: fileManager)
    else { throw EmbeddedRuntimeLocatorError.missingEntrypoint }
    return EmbeddedControlRuntime(rootURL: root, executableURL: executableURL, cliURL: cliURL)
  }

  private static func entrypoint(_ relativePath: String, payload: URL) throws -> URL {
    guard !relativePath.isEmpty,
      !relativePath.hasPrefix("/"),
      !relativePath.contains("\\"),
      !relativePath.contains("\0")
    else { throw EmbeddedRuntimeLocatorError.unsafeEntrypoint }
    let components = relativePath.split(separator: "/", omittingEmptySubsequences: false)
    guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
      throw EmbeddedRuntimeLocatorError.unsafeEntrypoint
    }
    let resolved = components.reduce(payload) { result, component in
      result.appendingPathComponent(String(component))
    }.standardizedFileURL
    guard resolved.path.hasPrefix(payload.path + "/") else {
      throw EmbeddedRuntimeLocatorError.unsafeEntrypoint
    }
    var current = payload
    for component in components {
      current.appendPathComponent(String(component))
      if (try? current.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
        throw EmbeddedRuntimeLocatorError.unsafeEntrypoint
      }
    }
    return resolved
  }

  private static func regularDirectory(_ url: URL) -> Bool {
    guard
      let values = try? url.resourceValues(forKeys: [
        .isDirectoryKey, .isSymbolicLinkKey,
      ])
    else { return false }
    return values.isDirectory == true && values.isSymbolicLink != true
  }

  private static func regularFile(_ url: URL, fileManager: FileManager) -> Bool {
    guard
      let values = try? url.resourceValues(forKeys: [
        .isRegularFileKey, .isSymbolicLinkKey,
      ])
    else { return false }
    return values.isRegularFile == true && values.isSymbolicLink != true
  }
}
