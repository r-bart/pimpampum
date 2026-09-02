import AppKit
import Foundation

extension WorkspaceOpener {
  init(
    fileManager: FileManager = .default,
    openDirectory: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }
  ) {
    self.init(
      validateDirectory: DirectoryOpener.isReadableDirectory(fileManager),
      openDirectory: openDirectory
    )
  }
}
