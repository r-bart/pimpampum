import AppKit
import Foundation

extension EmbeddedSetupBootstrap {
  /// The bootstrap of the running application bundle. A plain function reference, so the covered
  /// store can name it as a default without owning a closure that only fails under test.
  static func bundledFromApplication() throws -> EmbeddedSetupBootstrap {
    try bundled()
  }
}

/// Live `NSWorkspace` and `NSApplication` calls behind the relaunch decision. Kept apart from
/// `EmbeddedSetupBootstrap.swift` so that file can be measured to 100% without terminating the
/// test runner.
extension ApplicationRelaunchAdapters {
  static let live = ApplicationRelaunchAdapters(
    processIdentifier: ProcessInfo.processInfo.processIdentifier,
    launch: { request in
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.activates = true
      configuration.createsNewApplicationInstance = request.createsNewInstance
      configuration.arguments = request.arguments
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, any Error>) in
        NSWorkspace.shared.openApplication(at: request.url, configuration: configuration) {
          _, error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: ())
          }
        }
      }
    },
    terminateCurrentApplication: { NSApplication.shared.terminate(nil) },
    isApplicationRunning: { url in
      let target = url.canonicalBundleURL
      let current = ProcessInfo.processInfo.processIdentifier
      return NSWorkspace.shared.runningApplications.contains { application in
        application.processIdentifier != current
          && !application.isTerminated
          && application.bundleURL?.canonicalBundleURL == target
      }
    }
  )
}
