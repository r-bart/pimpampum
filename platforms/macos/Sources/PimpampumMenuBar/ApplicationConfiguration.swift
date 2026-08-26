import Foundation

struct DesktopInstallationConfiguration: Codable, Equatable, Sendable {
  let dataDirectory: String
}

protocol ApplicationConfigurationReading: Sendable {
  func data(at url: URL) throws -> Data
}

enum ApplicationConfiguration {
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
    if let resourceURL,
      let data = try? fileReader.data(
        at: resourceURL.appendingPathComponent("installation.json")
      ),
      let configuration = try? JSONDecoder().decode(
        DesktopInstallationConfiguration.self,
        from: data
      ),
      isSafeAbsolutePath(configuration.dataDirectory)
    {
      return directoryURL(configuration.dataDirectory)
    }
    return homeDirectory.appendingPathComponent(".pimpampum", isDirectory: true)
  }

  private static func isSafeAbsolutePath(_ path: String) -> Bool {
    NSString(string: path).isAbsolutePath && !path.contains("\0")
  }

  private static func directoryURL(_ path: String) -> URL {
    URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
  }
}
