import AppKit
import Foundation

extension WorkspaceOpener {
  init(
    fileManager: FileManager = .default,
    openDirectory: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }
  ) {
    self.init(
      validateDirectory: { path in
        var isDirectory = ObjCBool(false)
        return fileManager.fileExists(atPath: path, isDirectory: &isDirectory)
          && isDirectory.boolValue
          && fileManager.isReadableFile(atPath: path)
      },
      openDirectory: openDirectory
    )
  }
}
