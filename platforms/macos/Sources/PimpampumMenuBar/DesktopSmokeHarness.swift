import AppKit
import ApplicationServices
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
      if seed != nil { await store.refresh() }

      let opener = RecordingWorkspaceOpener()
      let rendered = try renderAndInspect(
        store: store,
        opener: opener,
        projectId: request.projectId
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
        accessibilityLabels: rendered.accessibilityLabels,
        activatedControlLabel: rendered.activatedControlLabel,
        openedWorkspacePath: opener.openedPaths.last
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
    projectId: String?
  ) throws -> (png: Data, accessibilityLabels: [String], activatedControlLabel: String?) {
    let content = StatusPopover(store: store, workspaceOpener: opener)
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
    if let projectId {
      let project = try DesktopSmokeLogic.project(withId: projectId, in: store.overview)
      let expectedLabel = "Open \(project.title) in Finder"
      guard let control = elements.first(where: { accessibilityLabel($0) == expectedLabel }) else {
        throw DesktopSmokeError.renderedControlMissing(expectedLabel)
      }
      guard AXUIElementPerformAction(control, kAXPressAction as CFString) == .success else {
        throw DesktopSmokeError.renderedControlActivationFailed(expectedLabel)
      }
      activatedControlLabel = expectedLabel
    }
    window.orderOut(nil)
    return (png, labels, activatedControlLabel)
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
