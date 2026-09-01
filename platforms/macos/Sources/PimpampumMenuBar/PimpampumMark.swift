import AppKit
import SwiftUI

@MainActor
enum PimpampumMarkAsset {
  static let resourceName = "PimpampumCompact"
  static let resourceExtension = "pdf"
  static let bundledTemplateImage = loadTemplateImage()

  static func loadTemplateImage(bundle: Bundle = .main) -> NSImage? {
    templateImage(
      at: bundle.url(forResource: resourceName, withExtension: resourceExtension)
    )
  }

  static func templateImage(at resourceURL: URL?) -> NSImage? {
    guard
      let resourceURL,
      let image = NSImage(contentsOf: resourceURL),
      image.size.width > 0,
      image.size.height > 0
    else { return nil }
    image.isTemplate = true
    return image
  }
}

@MainActor
struct PimpampumMark: View {
  let image: NSImage?
  let size: CGFloat

  init(image: NSImage? = PimpampumMarkAsset.bundledTemplateImage, size: CGFloat = 14) {
    self.image = image
    self.size = size
  }

  var body: some View {
    Group {
      if let image {
        Image(nsImage: image)
          .renderingMode(.template)
          .resizable()
          .scaledToFit()
      } else {
        MissingPimpampumMark()
      }
    }
    .frame(width: size, height: size)
  }
}

@MainActor
private struct MissingPimpampumMark: View {
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 2)
        .stroke(Color.red, lineWidth: 1.5)
      Path { path in
        path.move(to: CGPoint(x: 2, y: 2))
        path.addLine(to: CGPoint(x: 12, y: 12))
        path.move(to: CGPoint(x: 12, y: 2))
        path.addLine(to: CGPoint(x: 2, y: 12))
      }
      .stroke(Color.red, lineWidth: 1.5)
    }
    .help("\(PimpampumBrand.displayName) menu-bar mark is missing")
    .accessibilityLabel("\(PimpampumBrand.displayName) mark resource is missing")
  }
}

@MainActor
struct PimpampumStatusBadge: View {
  let kind: StatusBadgeKind
  let color: Color

  var body: some View {
    Image(systemName: kind.systemImageName)
      .symbolRenderingMode(.monochrome)
      .font(.system(size: 6, weight: .bold))
      .foregroundStyle(color)
      .frame(width: 7, height: 7)
      .background(.regularMaterial, in: Circle())
      .accessibilityHidden(true)
  }
}
