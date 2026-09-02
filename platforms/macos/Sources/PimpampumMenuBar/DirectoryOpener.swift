import Foundation

/// The check every "reveal this folder in Finder" action shares: refuse a path that is not a safe
/// absolute path, standardize it, require a readable directory to be there, and report a refused
/// open. `WorkspaceOpener` and `BackupDirectoryOpener` map the outcome onto their own error enums,
/// because each message names the folder the user chose.
enum DirectoryOpener {
  enum Outcome: Equatable, Sendable {
    case opened
    case invalidPath
    case unavailable(path: String)
    case openFailed(path: String)
  }

  static func open(
    at path: String,
    validateDirectory: (String) -> Bool,
    openDirectory: (URL) -> Bool
  ) -> Outcome {
    guard !path.isEmpty, !path.contains("\0"), NSString(string: path).isAbsolutePath else {
      return .invalidPath
    }
    let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    guard validateDirectory(url.path) else { return .unavailable(path: url.path) }
    guard openDirectory(url) else { return .openFailed(path: url.path) }
    return .opened
  }

  /// The production directory check both openers install: a readable directory, never a file.
  static func isReadableDirectory(_ fileManager: FileManager) -> (String) -> Bool {
    { path in
      var isDirectory = ObjCBool(false)
      return fileManager.fileExists(atPath: path, isDirectory: &isDirectory)
        && isDirectory.boolValue
        && fileManager.isReadableFile(atPath: path)
    }
  }
}
