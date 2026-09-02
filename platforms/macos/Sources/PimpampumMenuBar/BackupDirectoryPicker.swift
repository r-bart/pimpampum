import AppKit
import Foundation

@MainActor
protocol BackupDirectoryPicking {
  func chooseDirectory(initialDirectory: URL?) -> URL?
}

@MainActor
struct BackupDirectoryPicker: BackupDirectoryPicking {
  private let selectDirectory: (URL?) -> URL?

  init(selectDirectory: @escaping (URL?) -> URL?) {
    self.selectDirectory = selectDirectory
  }

  func chooseDirectory(initialDirectory: URL?) -> URL? {
    selectDirectory(initialDirectory)?.standardizedFileURL
  }
}

extension BackupDirectoryPicker {
  init() {
    self.init { initialDirectory in
      let panel = NSOpenPanel()
      panel.title = "Choose Backup Folder"
      panel.prompt = "Choose"
      panel.message = "Choose a folder for \(PimpampumBrand.displayName)'s current backup snapshot."
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.allowsMultipleSelection = false
      panel.canCreateDirectories = true
      panel.directoryURL = initialDirectory
      return panel.runModal() == .OK ? panel.url : nil
    }
  }
}

@MainActor
protocol BackupDirectoryOpening {
  func openDirectory(at path: String) throws
}

enum BackupDirectoryOpenError: LocalizedError, Equatable {
  case invalidPath
  case unavailable(path: String)
  case openFailed(path: String)

  var errorDescription: String? {
    switch self {
    case .invalidPath: "The backup folder path is invalid."
    case .unavailable(let path): "The backup folder is missing or inaccessible: \(path)"
    case .openFailed(let path): "Finder could not open the backup folder: \(path)"
    }
  }
}

@MainActor
struct BackupDirectoryOpener: BackupDirectoryOpening {
  private let validateDirectory: (String) -> Bool
  private let openDirectory: (URL) -> Bool

  init(
    validateDirectory: @escaping (String) -> Bool,
    openDirectory: @escaping (URL) -> Bool
  ) {
    self.validateDirectory = validateDirectory
    self.openDirectory = openDirectory
  }

  init(
    fileManager: FileManager = .default,
    openDirectory: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }
  ) {
    self.init(
      validateDirectory: DirectoryOpener.isReadableDirectory(fileManager),
      openDirectory: openDirectory
    )
  }

  func openDirectory(at path: String) throws {
    switch DirectoryOpener.open(
      at: path,
      validateDirectory: validateDirectory,
      openDirectory: openDirectory
    ) {
    case .opened: return
    case .invalidPath: throw BackupDirectoryOpenError.invalidPath
    case .unavailable(let path): throw BackupDirectoryOpenError.unavailable(path: path)
    case .openFailed(let path): throw BackupDirectoryOpenError.openFailed(path: path)
    }
  }
}
