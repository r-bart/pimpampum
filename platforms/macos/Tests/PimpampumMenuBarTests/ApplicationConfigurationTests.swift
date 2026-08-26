import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite("Application configuration")
struct ApplicationConfigurationTests {
  @Test("Prefers an absolute environment data directory")
  func environmentDirectory() {
    let result = ApplicationConfiguration.dataDirectory(
      environment: ["PIMPAMPUM_DATA_DIR": "/tmp/Pimpampum Data"],
      resourceURL: nil,
      homeDirectory: URL(fileURLWithPath: "/Users/example")
    )
    #expect(result.path == "/tmp/Pimpampum Data")
  }

  @Test("Reads the installed non-secret configuration")
  func installedConfiguration() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let data = try JSONEncoder().encode(
      DesktopInstallationConfiguration(dataDirectory: "/Users/example/Custom Data")
    )
    try data.write(to: root.appendingPathComponent("installation.json"))

    let result = ApplicationConfiguration.dataDirectory(
      environment: [:],
      resourceURL: root,
      homeDirectory: URL(fileURLWithPath: "/Users/example")
    )
    #expect(result.path == "/Users/example/Custom Data")
  }

  @Test("Rejects unsafe configuration and falls back to the home directory")
  func safeFallback() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data("{\"dataDirectory\":\"relative\"}".utf8)
      .write(to: root.appendingPathComponent("installation.json"))

    let home = URL(fileURLWithPath: "/Users/example")
    let result = ApplicationConfiguration.dataDirectory(
      environment: ["PIMPAMPUM_DATA_DIR": "relative"],
      resourceURL: root,
      homeDirectory: home
    )
    #expect(result.path == "/Users/example/.pimpampum")
  }
}
