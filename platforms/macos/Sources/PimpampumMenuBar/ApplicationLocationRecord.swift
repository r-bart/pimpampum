import Foundation

extension URL {
  /// One spelling for a bundle path, so `/private/tmp` and `/tmp`, or a symlinked Applications
  /// folder and its target, compare equal.
  var canonicalBundleURL: URL { resolvingSymlinksInPath().standardizedFileURL }
}

/// Where setup left the application bundle and whether Pimpampum owns that copy. The CLI writes
/// `application-path.json` next to the receipt when it installs; this is the Swift reader of that
/// record, so both languages agree on which bundle is the app.
struct ApplicationLocationRecord: Equatable, Sendable {
  static let fileName = "application-path.json"
  static let currentSchemaVersion = 2
  static let maximumBytes = 4_096

  let url: URL
  let managed: Bool

  /// The one location Pimpampum manages itself. Schema 1 recorded only a path, so this decides
  /// `managed` for those files and stands in when no record has been written yet.
  static func managedApplicationURL(homeDirectory: URL) -> URL {
    homeDirectory
      .appendingPathComponent("Applications", isDirectory: true)
      .appendingPathComponent("Pimpampum.app", isDirectory: true)
      .standardizedFileURL
  }

  /// Decodes schema 1 (`path` only) and schema 2 (`path` and `managed`). Anything else is not a
  /// record: a relative path, a NUL byte, a non-object document, or a version this app does not
  /// know. Booleans and integers are checked by type, because JSON `1` and `true` arrive as the
  /// same NSNumber.
  static func decode(_ data: Data, homeDirectory: URL) -> ApplicationLocationRecord? {
    guard data.count <= maximumBytes,
      let object = try? JSONSerialization.jsonObject(with: data),
      let dictionary = object as? [String: Any],
      let path = dictionary["path"] as? String,
      NSString(string: path).isAbsolutePath,
      !path.contains("\0")
    else { return nil }
    let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    switch integer(dictionary["schemaVersion"]) {
    case 1:
      let managedURL = managedApplicationURL(homeDirectory: homeDirectory)
      return ApplicationLocationRecord(
        url: url,
        managed: url.canonicalBundleURL.path == managedURL.canonicalBundleURL.path
      )
    case 2:
      guard let managed = boolean(dictionary["managed"]) else { return nil }
      return ApplicationLocationRecord(url: url, managed: managed)
    default:
      return nil
    }
  }

  static func read(
    dataDirectory: URL,
    homeDirectory: URL,
    reader: any ApplicationConfigurationReading
  ) -> ApplicationLocationRecord? {
    guard let data = try? reader.data(at: dataDirectory.appendingPathComponent(fileName)) else {
      return nil
    }
    return decode(data, homeDirectory: homeDirectory)
  }

  /// What the CLI assumes when no record exists: a bundle already inside an Applications folder
  /// is the app and is left alone; anything else is copied to the managed location.
  static func inferred(sourceApplicationURL: URL, homeDirectory: URL) -> ApplicationLocationRecord {
    let source = sourceApplicationURL.canonicalBundleURL
    let applicationFolders = [
      URL(fileURLWithPath: "/Applications", isDirectory: true),
      homeDirectory.appendingPathComponent("Applications", isDirectory: true),
    ].map { $0.canonicalBundleURL.path }
    if applicationFolders.contains(source.deletingLastPathComponent().path) {
      return ApplicationLocationRecord(url: source, managed: false)
    }
    return ApplicationLocationRecord(
      url: managedApplicationURL(homeDirectory: homeDirectory),
      managed: true
    )
  }

  private static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }
    return number.intValue
  }

  private static func boolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
      return nil
    }
    return number.boolValue
  }
}
