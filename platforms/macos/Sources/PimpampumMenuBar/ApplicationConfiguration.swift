import Foundation

/// The installation marker the CLI writes at install. Schema 2 lives at a fixed path outside every
/// bundle, `~/Library/Application Support/Pimpampum/installation.json`, as
/// `{ "schemaVersion": 2, "dataDirectory": … }`. Releases before 1.2.12 wrote a schema-less
/// `{ "dataDirectory": … }` inside the bundle's `Contents/Resources`, which broke the code seal of a
/// signed copy; that file is still read, for one release, when no fixed-path marker exists.
struct DesktopInstallationConfiguration: Codable, Equatable, Sendable {
  let dataDirectory: String
}

protocol ApplicationConfigurationReading: Sendable {
  func data(at url: URL) throws -> Data
}

enum ApplicationConfiguration {
  /// Relative to the home directory; the CLI's `installationMarkerPath` spells the same path.
  static let installationMarkerRelativePath =
    "Library/Application Support/Pimpampum/installation.json"
  /// The legacy marker's name inside the bundle resources.
  static let legacyInstallationMarkerName = "installation.json"
  /// A marker is one short JSON object. Anything larger is not a marker.
  static let maximumMarkerBytes = 4_096

  static func installationMarkerURL(homeDirectory: URL) -> URL {
    homeDirectory.appendingPathComponent(installationMarkerRelativePath).standardizedFileURL
  }

  /// Environment first, then the fixed-path marker, then the legacy in-bundle marker, then the
  /// default `~/.pimpampum`. Every candidate must name an absolute NUL-free path or it is skipped.
  static func dataDirectory(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    resourceURL: URL? = Bundle.main.resourceURL,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
    fileReader: any ApplicationConfigurationReading = LocalApplicationConfigurationReader()
  ) -> URL {
    if let configured = environment["PIMPAMPUM_DATA_DIR"],
      isSafeAbsolutePath(configured)
    {
      return directoryURL(configured)
    }
    let markers = [
      installationMarkerURL(homeDirectory: homeDirectory),
      resourceURL?.appendingPathComponent(legacyInstallationMarkerName),
    ].compactMap { $0 }
    for marker in markers {
      if let configured = configuredDirectory(at: marker, fileReader: fileReader) {
        return configured
      }
    }
    return homeDirectory.appendingPathComponent(".pimpampum", isDirectory: true)
  }

  private static func configuredDirectory(
    at url: URL,
    fileReader: any ApplicationConfigurationReading
  ) -> URL? {
    guard let data = try? fileReader.data(at: url),
      data.count <= maximumMarkerBytes,
      let configuration = try? JSONDecoder().decode(
        DesktopInstallationConfiguration.self,
        from: data
      ),
      isSafeAbsolutePath(configuration.dataDirectory)
    else { return nil }
    return directoryURL(configuration.dataDirectory)
  }

  private static func isSafeAbsolutePath(_ path: String) -> Bool {
    NSString(string: path).isAbsolutePath && !path.contains("\0")
  }

  private static func directoryURL(_ path: String) -> URL {
    URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
  }
}
