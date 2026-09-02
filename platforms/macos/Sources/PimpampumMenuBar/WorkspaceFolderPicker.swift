import AppKit
import Foundation

@MainActor
protocol WorkspaceFolderPicking {
  func chooseDirectory(initialDirectory: URL?) -> URL?
}

/// Thin `NSOpenPanel` adapter, like `BackupDirectoryPicker`. The choice it returns is turned into a
/// `WorkspaceRegistrationRequest` by the covered `SetupSession`; nothing is decided here.
@MainActor
struct WorkspaceFolderPicker: WorkspaceFolderPicking {
  private let selectDirectory: (URL?) -> URL?

  init(selectDirectory: @escaping (URL?) -> URL?) {
    self.selectDirectory = selectDirectory
  }

  func chooseDirectory(initialDirectory: URL?) -> URL? {
    selectDirectory(initialDirectory)?.standardizedFileURL
  }
}

extension WorkspaceFolderPicker {
  init() {
    self.init { initialDirectory in
      let panel = NSOpenPanel()
      panel.title = "Choose a Workspace Folder"
      panel.prompt = "Add"
      panel.message =
        "Choose the folder your agents work in. \(PimpampumBrand.displayName) registers it as a workspace."
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.allowsMultipleSelection = false
      panel.canCreateDirectories = true
      panel.directoryURL = initialDirectory
      return panel.runModal() == .OK ? panel.url : nil
    }
  }
}
