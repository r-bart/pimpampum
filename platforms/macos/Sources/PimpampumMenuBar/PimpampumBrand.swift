import Foundation

enum PimpampumBrand {
  static let displayName = "pim • pam • pum"
  static let settingsTitle = "\(displayName) Settings"
  static let quitTitle = "Quit"

  static func versionText(bundle: Bundle = .main) -> String {
    let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return "Version \(version ?? "1.2.0")"
  }
}
