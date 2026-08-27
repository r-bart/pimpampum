import AppKit
import ApplicationServices
import CryptoKit
import Foundation
import SwiftUI

private actor SmokeOverviewReader: OverviewReading {
  private var seed: Overview?
  private let live: OverviewClient

  init(seed: Overview?, live: OverviewClient) {
    self.seed = seed
    self.live = live
  }

  func fetchOverview() async throws -> Overview {
    if let seed {
      self.seed = nil
      return seed
    }
    return try await live.fetchOverview()
  }
}

@MainActor
private final class RecordingWorkspaceOpener: WorkspaceOpening {
  private(set) var openedPaths: [String] = []
  private let production = WorkspaceOpener()

  func openWorkspace(at path: String) throws {
    try production.openWorkspace(at: path)
    openedPaths.append(path)
  }
}

@MainActor
private final class SmokeActionRecorder {
  private(set) var quitInvoked = false

  func recordQuit() {
    quitInvoked = true
  }
}

private struct SmokeWindowInspection {
  let reused: Bool?
  let count: Int?
  let width: Int?
  let height: Int?
  let focused: Bool?
  let backupState: String?
  let configuredPath: String?
  let errorPresent: Bool?

  static let notExercised = SmokeWindowInspection(
    reused: nil,
    count: nil,
    width: nil,
    height: nil,
    focused: nil,
    backupState: nil,
    configuredPath: nil,
    errorPresent: nil
  )
}

@MainActor
enum DesktopSmokeHarness {
  static func run(arguments: [String], dataDirectory: URL) async -> Bool {
    let request: SmokeHarnessRequest
    do {
      guard let parsed = try DesktopSmokeLogic.request(from: arguments) else { return false }
      request = parsed
    } catch {
      report(error)
      return true
    }

    do {
      let seed = try request.seedURL.map { url in
        try DesktopSmokeLogic.decodeOverview(Data(contentsOf: url))
      }
      let client = OverviewClient(
        receiptURL: dataDirectory.appendingPathComponent("install-receipt.json"),
        tokenURL: dataDirectory.appendingPathComponent("token")
      )
      let reader = SmokeOverviewReader(seed: seed, live: client)
      let store = OverviewStore(reader: reader)
      await store.refresh()
      if seed != nil, request.refreshAfterSeed { await store.refresh() }

      guard
        let markURL = Bundle.main.url(
          forResource: PimpampumMarkAsset.resourceName,
          withExtension: PimpampumMarkAsset.resourceExtension
        ),
        let markImage = PimpampumMarkAsset.templateImage(at: markURL)
      else {
        throw DesktopSmokeError.markResourceMissing
      }
      let markData = try Data(contentsOf: markURL)
      let markHash = SHA256.hash(data: markData).map { String(format: "%02x", $0) }.joined()

      let opener = RecordingWorkspaceOpener()
      let backupClient = BackupSettingsClient(
        receiptURL: dataDirectory.appendingPathComponent("install-receipt.json"),
        tokenURL: dataDirectory.appendingPathComponent("token")
      )
      let backupStore = BackupSettingsStore(client: backupClient)
      let syncClient = SyncSettingsClient(
        receiptURL: dataDirectory.appendingPathComponent("install-receipt.json"),
        tokenURL: dataDirectory.appendingPathComponent("token")
      )
      let syncStore = SyncSettingsStore(client: syncClient)
      let settingsWindowController = SyncSettingsWindowController(
        syncStore: syncStore,
        backupStore: backupStore,
        showBackupInitially: true
      )
      if request.controlLabel == "Settings…" {
        await backupStore.load()
      }
      let actionRecorder = SmokeActionRecorder()
      let rendered = try renderAndInspect(
        store: store,
        opener: opener,
        backupStore: backupStore,
        settingsWindowController: settingsWindowController,
        actionRecorder: actionRecorder,
        projectId: request.projectId,
        controlLabel: request.controlLabel
      )
      try rendered.png.write(to: request.pngURL, options: .atomic)

      let visualState = StatusPopover.visualState(
        connectionState: store.connectionState,
        overview: store.overview
      )
      let activeCount = StatusPopover.visibleActiveCount(
        connectionState: store.connectionState,
        overview: store.overview
      )
      let snapshot = DesktopSmokeLogic.snapshot(
        overview: store.overview,
        visualState: visualState,
        activeCount: activeCount,
        connectionState: store.connectionState,
        stale: store.isStale,
        png: rendered.png,
        markResourceSha256: markHash,
        markIsTemplate: markImage.isTemplate,
        accessibilityLabels: rendered.accessibilityLabels,
        activatedControlLabel: rendered.activatedControlLabel,
        openedWorkspacePath: opener.openedPaths.last,
        settingsWindowReused: rendered.settingsWindow.reused,
        settingsWindowCount: rendered.settingsWindow.count,
        settingsWindowWidth: rendered.settingsWindow.width,
        settingsWindowHeight: rendered.settingsWindow.height,
        settingsWindowFocused: rendered.settingsWindow.focused,
        settingsBackupState: rendered.settingsWindow.backupState,
        settingsConfiguredPath: rendered.settingsWindow.configuredPath,
        settingsErrorPresent: rendered.settingsWindow.errorPresent,
        quitActionInvoked: actionRecorder.quitInvoked
      )
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      try encoder.encode(snapshot).write(to: request.jsonURL, options: .atomic)
    } catch {
      report(error)
    }
    return true
  }

  private static func renderAndInspect(
    store: OverviewStore,
    opener: RecordingWorkspaceOpener,
    backupStore: BackupSettingsStore,
    settingsWindowController: SyncSettingsWindowController,
    actionRecorder: SmokeActionRecorder,
    projectId: String?,
    controlLabel: String?
  ) throws -> (
    png: Data,
    accessibilityLabels: [String],
    activatedControlLabel: String?,
    settingsWindow: SmokeWindowInspection
  ) {
    let content = NativeSettingsStatusPopover(
      store: store,
      workspaceOpener: opener,
      settingsWindowOpener: settingsWindowController,
      quitApplication: actionRecorder.recordQuit
    )
      .frame(width: 360, height: 560)
    let renderer = ImageRenderer(content: content)
    renderer.scale = 2
    guard let image = renderer.nsImage,
      let tiff = image.tiffRepresentation,
      let representation = NSBitmapImageRep(data: tiff),
      let png = representation.representation(using: .png, properties: [:]),
      !png.isEmpty
    else {
      throw DesktopSmokeError.renderFailed
    }

    let hostingView = NSHostingView(rootView: content)
    hostingView.frame = NSRect(x: 0, y: 0, width: 360, height: 560)
    let window = NSWindow(
      contentRect: hostingView.frame,
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    window.contentView = hostingView
    window.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
    hostingView.layoutSubtreeIfNeeded()
    window.displayIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))

    let elements = accessibilityElements()
    let labels = elements.compactMap(accessibilityLabel)
    var activatedControlLabel: String?
    var settingsWindow = SmokeWindowInspection.notExercised
    if let projectId {
      let project = try DesktopSmokeLogic.project(withId: projectId, in: store.overview)
      let expectedLabel = "Open \(project.title) in Finder"
      guard
        let control = elements.first(where: {
          accessibilityLabel($0) == expectedLabel && accessibilityRole($0) == kAXButtonRole
        })
      else {
        throw DesktopSmokeError.renderedControlMissing(expectedLabel)
      }
      guard AXUIElementPerformAction(control, kAXPressAction as CFString) == .success else {
        throw DesktopSmokeError.renderedControlActivationFailed(expectedLabel)
      }
      activatedControlLabel = expectedLabel
    }
    if let controlLabel {
      guard
        let control = elements.first(where: {
          accessibilityLabel($0) == controlLabel && accessibilityRole($0) == kAXButtonRole
        })
      else {
        throw DesktopSmokeError.renderedControlMissing(controlLabel)
      }
      guard AXUIElementPerformAction(control, kAXPressAction as CFString) == .success else {
        throw DesktopSmokeError.renderedControlActivationFailed(controlLabel)
      }
      activatedControlLabel = controlLabel
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))

      if controlLabel == "Settings…" {
        guard !window.isVisible else {
          throw DesktopSmokeError.popoverDismissalFailed
        }
        let settingsWindows = {
          NSApplication.shared.windows.filter { $0.title == PimpampumBrand.settingsTitle }
        }
        let firstWindow = settingsWindows().first
        settingsWindowController.openSettings()
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        let currentWindow = settingsWindows().first
        let contentSize = currentWindow?.contentLayoutRect.size
        settingsWindow = SmokeWindowInspection(
          reused: firstWindow != nil && firstWindow === currentWindow,
          count: settingsWindows().count,
          width: contentSize.map { Int($0.width.rounded()) },
          height: contentSize.map { Int($0.height.rounded()) },
          focused: currentWindow.map {
            $0.isKeyWindow || NSApplication.shared.orderedWindows.first === $0
          },
          backupState: backupStore.settings?.state.rawValue,
          configuredPath: backupStore.settings?.directory,
          errorPresent: backupStore.settings?.error != nil || backupStore.errorMessage != nil
        )
        currentWindow?.close()
      }
    }
    window.orderOut(nil)
    return (png, labels, activatedControlLabel, settingsWindow)
  }

  private static func accessibilityElements() -> [AXUIElement] {
    let root = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
    var result = [root]
    var pending = accessibilityChildren(root)
    var visited = Set<CFHashCode>()
    while let element = pending.popLast() {
      guard visited.insert(CFHash(element)).inserted else { continue }
      result.append(element)
      pending.append(contentsOf: accessibilityChildren(element))
    }
    return result
  }

  private static func accessibilityLabel(_ element: AXUIElement) -> String? {
    for attribute in [kAXDescriptionAttribute, kAXTitleAttribute] {
      var value: CFTypeRef?
      if AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let label = value as? String,
        !label.isEmpty
      {
        return label
      }
    }
    return nil
  }

  private static func accessibilityRole(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success
    else {
      return nil
    }
    return value as? String
  }

  private static func accessibilityChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
      let children = value as? [AXUIElement]
    else {
      return []
    }
    return children
  }

  private static func report(_ error: Error) {
    FileHandle.standardError.write(Data("UI smoke failed: \(error.localizedDescription)\n".utf8))
  }
}
