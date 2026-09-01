import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite("Application configuration")
struct ApplicationConfigurationTests {
  private func temporaryRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func writeMarker(_ text: String, at url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
  }

  @Test("Prefers an absolute environment data directory")
  func environmentDirectory() {
    let result = ApplicationConfiguration.dataDirectory(
      environment: ["PIMPAMPUM_DATA_DIR": "/tmp/Pimpampum Data"],
      resourceURL: nil,
      homeDirectory: URL(fileURLWithPath: "/Users/example")
    )
    #expect(result.path == "/tmp/Pimpampum Data")
  }

  @Test("Reads the schema 2 marker at its fixed path outside the bundle")
  func fixedPathMarker() throws {
    // L-21: the marker used to sit inside `Contents/Resources`, where it broke the code seal of a
    // signed copy. The CLI now writes it under Application Support, from the home directory alone.
    let home = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: home) }
    let marker = ApplicationConfiguration.installationMarkerURL(homeDirectory: home)
    #expect(
      marker.path
        == home.appendingPathComponent("Library/Application Support/Pimpampum/installation.json")
        .standardizedFileURL.path)
    try writeMarker(
      #"{"schemaVersion":2,"dataDirectory":"/Users/example/Custom Data"}"#, at: marker)

    let result = ApplicationConfiguration.dataDirectory(
      environment: [:],
      resourceURL: nil,
      homeDirectory: home
    )
    #expect(result.path == "/Users/example/Custom Data")
  }

  @Test("Still reads the legacy in-bundle marker for one release")
  func legacyMarkerFallback() throws {
    let home = try temporaryRoot()
    let resources = try temporaryRoot()
    defer {
      try? FileManager.default.removeItem(at: home)
      try? FileManager.default.removeItem(at: resources)
    }
    let data = try JSONEncoder().encode(
      DesktopInstallationConfiguration(dataDirectory: "/Users/example/Legacy Data")
    )
    try data.write(to: resources.appendingPathComponent("installation.json"))

    let result = ApplicationConfiguration.dataDirectory(
      environment: [:],
      resourceURL: resources,
      homeDirectory: home
    )
    #expect(result.path == "/Users/example/Legacy Data")
  }

  @Test("The fixed-path marker wins over the legacy one")
  func fixedPathMarkerPrecedence() throws {
    let home = try temporaryRoot()
    let resources = try temporaryRoot()
    defer {
      try? FileManager.default.removeItem(at: home)
      try? FileManager.default.removeItem(at: resources)
    }
    try writeMarker(
      #"{"schemaVersion":2,"dataDirectory":"/Users/example/Current"}"#,
      at: ApplicationConfiguration.installationMarkerURL(homeDirectory: home))
    try writeMarker(
      #"{"dataDirectory":"/Users/example/Legacy"}"#,
      at: resources.appendingPathComponent("installation.json"))

    let result = ApplicationConfiguration.dataDirectory(
      environment: [:],
      resourceURL: resources,
      homeDirectory: home
    )
    #expect(result.path == "/Users/example/Current")
  }

  @Test("Rejects unsafe configuration and falls back to the home directory")
  func safeFallback() throws {
    let home = try temporaryRoot()
    let resources = try temporaryRoot()
    defer {
      try? FileManager.default.removeItem(at: home)
      try? FileManager.default.removeItem(at: resources)
    }
    try writeMarker(
      "{\"dataDirectory\":\"relative\"}", at: resources.appendingPathComponent("installation.json"))
    try writeMarker(
      "{\"schemaVersion\":2,\"dataDirectory\":\"/Users/example/Bad\\u0000\"}",
      at: ApplicationConfiguration.installationMarkerURL(homeDirectory: home))

    let result = ApplicationConfiguration.dataDirectory(
      environment: ["PIMPAMPUM_DATA_DIR": "relative"],
      resourceURL: resources,
      homeDirectory: home
    )
    #expect(result.path == home.appendingPathComponent(".pimpampum").path)
  }

  @Test("Ignores a marker that is too large or not JSON")
  func boundedMarker() throws {
    let home = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: home) }
    let marker = ApplicationConfiguration.installationMarkerURL(homeDirectory: home)
    let padding = String(repeating: " ", count: ApplicationConfiguration.maximumMarkerBytes)
    try writeMarker(#"{"dataDirectory":"/Users/example/Big"}"# + padding, at: marker)
    #expect(
      ApplicationConfiguration.dataDirectory(environment: [:], resourceURL: nil, homeDirectory: home)
        .path == home.appendingPathComponent(".pimpampum").path)

    try writeMarker("not json", at: marker)
    #expect(
      ApplicationConfiguration.dataDirectory(environment: [:], resourceURL: nil, homeDirectory: home)
        .path == home.appendingPathComponent(".pimpampum").path)
  }
}
