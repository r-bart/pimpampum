import Foundation

// The production boundary is SystemWorkspaceAdapter, backed by NSWorkspace.

@MainActor
protocol WorkspaceOpening {
  func openWorkspace(at path: String) throws
}

enum WorkspaceOpenError: LocalizedError, Equatable {
  case invalidPath
  case unavailable(path: String)
  case openFailed(path: String)

  var errorDescription: String? {
    switch self {
    case .invalidPath:
      "The workspace path is invalid."
    case .unavailable(let path):
      "The workspace directory is missing or inaccessible: \(path)"
    case .openFailed(let path):
      "Finder could not open the workspace directory: \(path)"
    }
  }
}

@MainActor
struct WorkspaceOpener: WorkspaceOpening {
  private let validateDirectory: (String) -> Bool
  private let openDirectory: (URL) -> Bool

  init(
    validateDirectory: @escaping (String) -> Bool,
    openDirectory: @escaping (URL) -> Bool
  ) {
    self.validateDirectory = validateDirectory
    self.openDirectory = openDirectory
  }

  func openWorkspace(at path: String) throws {
    switch DirectoryOpener.open(
      at: path,
      validateDirectory: validateDirectory,
      openDirectory: openDirectory
    ) {
    case .opened: return
    case .invalidPath: throw WorkspaceOpenError.invalidPath
    case .unavailable(let path): throw WorkspaceOpenError.unavailable(path: path)
    case .openFailed(let path): throw WorkspaceOpenError.openFailed(path: path)
    }
  }
}
