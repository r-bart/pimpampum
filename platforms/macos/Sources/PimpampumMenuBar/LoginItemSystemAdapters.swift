import AppKit
import Foundation
import ServiceManagement

struct MainAppLoginItemService: LoginItemServicing {
  var state: LoginItemRegistrationState {
    switch SMAppService.mainApp.status {
    case .enabled:
      return .enabled
    case .requiresApproval:
      return .requiresApproval
    case .notFound, .notRegistered:
      return .error
    @unknown default:
      return .error
    }
  }

  func register() throws {
    try SMAppService.mainApp.register()
  }

  func unregister() async throws {
    try await SMAppService.mainApp.unregister()
    let currentProcess = ProcessInfo.processInfo.processIdentifier
    for application in NSRunningApplication.runningApplications(
      withBundleIdentifier: "dev.pimpampum.menubar"
    ) where application.processIdentifier != currentProcess {
      application.terminate()
    }
  }
}

struct LocalLoginRegistrationFiles: LoginRegistrationFileAccess {
  func read(_ url: URL) throws -> Data {
    try Data(contentsOf: url)
  }

  func writePrivate(_ data: Data, to url: URL) throws {
    let manager = FileManager.default
    try manager.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let temporaryURL = url.deletingLastPathComponent()
      .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
    do {
      try data.write(to: temporaryURL, options: .withoutOverwriting)
      try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporaryURL.path)
      if manager.fileExists(atPath: url.path) {
        _ = try manager.replaceItemAt(url, withItemAt: temporaryURL)
      } else {
        try manager.moveItem(at: temporaryURL, to: url)
      }
      try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    } catch {
      try? manager.removeItem(at: temporaryURL)
      throw error
    }
  }
}

extension LoginRegistrationCoordinator {
  init() {
    self.init(
      service: MainAppLoginItemService(),
      files: LocalLoginRegistrationFiles(),
      now: Date.init
    )
  }
}

enum LoginApprovalSettings {
  static func open() {
    guard
      let url = URL(
        string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
      )
    else { return }
    NSWorkspace.shared.open(url)
  }
}
