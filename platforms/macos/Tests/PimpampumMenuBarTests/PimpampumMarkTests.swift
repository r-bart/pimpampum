import AppKit
import SwiftUI
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
@MainActor
struct PimpampumMarkTests {
  @Test
  func loadsTheApprovedPackagedPdfAsAMonochromeTemplate() throws {
    #expect(PimpampumMarkAsset.resourceName == "PimpampumCompact")
    #expect(PimpampumMarkAsset.resourceExtension == "pdf")

    let image = PimpampumMarkAsset.templateImage(at: compactMarkURL)
    #expect(image != nil)
    #expect(image?.isTemplate == true)
    #expect((image?.size.width ?? 0) > 0)
    #expect((image?.size.height ?? 0) > 0)

    _ = PimpampumMark(image: image).body
  }

  @Test
  func missingOrInvalidAssetsFailClosedWithoutAnIdentityFallback() {
    #expect(PimpampumMarkAsset.templateImage(at: nil) == nil)

    let missing = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-missing-mark-\(UUID().uuidString).pdf")
    #expect(PimpampumMarkAsset.templateImage(at: missing) == nil)
    _ = PimpampumMark(image: nil).body
  }

  @Test
  func everySemanticStateUsesOneExternalBadgeAndTheSameMarkComponent() {
    let expected: [(StatusVisualState, StatusBadgeKind)] = [
      (.loading, .loadingRing),
      (.active, .activeDot),
      (.available, .availableDiamond),
      (.draft, .draftRing),
      (.complete, .completionCheck),
      (.cancelled, .cancellationX),
      (.empty, .emptyRing),
      (.stale, .disconnected),
      (.offline, .disconnected),
      (.authenticationError, .alert),
      (.incompatible, .alert),
    ]

    for (state, kind) in expected {
      #expect(state.badgeKind == kind)
      #expect(!kind.systemImageName.isEmpty)
      #expect(!kind.systemImageName.contains("wifi"))
      #expect(!kind.systemImageName.contains("cloud"))
      #expect(!kind.systemImageName.contains("database"))
      _ = PimpampumStatusBadge(kind: kind, color: state.color).body
      _ = StatusIndicator(state: state, activeCount: state == .active ? 7 : 0).body
    }
  }

  @Test(arguments: [
    (-1, nil),
    (0, nil),
    (1, "1"),
    (9, "9"),
    (42, "42"),
    (99, "99"),
    (100, "99+"),
    (10_000, "99+"),
  ] as [(Int, String?)])
  func formatsTheBoundedActiveClaimCount(activeCount: Int, expected: String?) {
    #expect(StatusIndicatorPresentation.displayCount(activeCount) == expected)
  }

  @Test
  func combinesStatusAndUncappedCountIntoOneAccessibleLabel() {
    #expect(
      StatusIndicatorPresentation.accessibilityLabel(state: .active, activeCount: 1)
        == "Pimpampum: Active, 1 active claim")
    #expect(
      StatusIndicatorPresentation.accessibilityLabel(state: .available, activeCount: 0)
        == "Pimpampum: Work available, 0 active claims")
    #expect(
      StatusIndicatorPresentation.accessibilityLabel(state: .stale, activeCount: 100)
        == "Pimpampum: Offline — stale data, 100 active claims")
    #expect(
      StatusIndicatorPresentation.accessibilityLabel(state: .offline, activeCount: -1)
        == "Pimpampum: Offline, 0 active claims")
  }

  private var compactMarkURL: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("Resources/PimpampumCompact.pdf")
  }
}
