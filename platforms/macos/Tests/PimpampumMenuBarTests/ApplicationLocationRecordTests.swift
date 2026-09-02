import Foundation
import Testing

@testable import PimpampumMenuBar

private struct MemoryReader: ApplicationConfigurationReading {
  let values: [URL: Data]
  func data(at url: URL) throws -> Data {
    guard let data = values[url] else { throw TestFailure.expected }
    return data
  }
}

/// The CLI records where it put the app. Swift reads the same file so both sides relaunch, register
/// and remove the same bundle.
@Suite("Application location record")
struct ApplicationLocationRecordTests {
  private let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)

  private func decode(_ json: String) -> ApplicationLocationRecord? {
    ApplicationLocationRecord.decode(Data(json.utf8), homeDirectory: home)
  }

  @Test
  func readsSchemaTwoWithItsOwnershipFlag() {
    let adopted = decode(#"{"schemaVersion":2,"path":"/Applications/Pimpampum.app","managed":false}"#)
    #expect(adopted?.url.path == "/Applications/Pimpampum.app")
    #expect(adopted?.managed == false)

    let managed = decode(
      #"{ "schemaVersion": 2, "path": "/Users/example/Applications/Pimpampum.app", "managed": true }"#
        + "\n")
    #expect(managed?.managed == true)
  }

  @Test
  func derivesOwnershipForSchemaOneFromTheManagedPath() {
    #expect(
      decode(#"{"schemaVersion":1,"path":"/Users/example/Applications/Pimpampum.app"}"#)?.managed
        == true)
    let adopted = decode(#"{"schemaVersion":1,"path":"/Applications/Pimpampum.app"}"#)
    #expect(adopted?.managed == false)
    #expect(adopted?.url.path == "/Applications/Pimpampum.app")
  }

  @Test(arguments: [
    #"{"schemaVersion":2,"path":"Applications/Pimpampum.app","managed":true}"#,
    "{\"schemaVersion\":2,\"path\":\"/Applications/Pim\\u0000pampum.app\",\"managed\":true}",
    #"["/Applications/Pimpampum.app"]"#,
    #""/Applications/Pimpampum.app""#,
    #"{"schemaVersion":2,"managed":true}"#,
    #"{"schemaVersion":2,"path":7,"managed":true}"#,
    #"{"schemaVersion":3,"path":"/Applications/Pimpampum.app","managed":true}"#,
    #"{"schemaVersion":true,"path":"/Applications/Pimpampum.app","managed":true}"#,
    #"{"path":"/Applications/Pimpampum.app","managed":true}"#,
    #"{"schemaVersion":2,"path":"/Applications/Pimpampum.app"}"#,
    #"{"schemaVersion":2,"path":"/Applications/Pimpampum.app","managed":1}"#,
    #"{"schemaVersion":2,"path":"/Applications/Pimpampum.app","managed":"yes"}"#,
    "not json",
    "",
  ])
  func rejectsAnythingThatIsNotARecord(json: String) {
    #expect(decode(json) == nil)
  }

  @Test
  func rejectsAnOversizedFile() {
    let padding = String(repeating: " ", count: ApplicationLocationRecord.maximumBytes)
    #expect(decode(#"{"schemaVersion":2,"path":"/a","managed":true}"# + padding) == nil)
  }

  @Test
  func readsTheFileNextToTheReceiptAndTreatsAMissingOneAsNoRecord() {
    let dataDirectory = URL(fileURLWithPath: "/Users/example/.pimpampum", isDirectory: true)
    let file = dataDirectory.appendingPathComponent("application-path.json")
    let record = ApplicationLocationRecord.read(
      dataDirectory: dataDirectory,
      homeDirectory: home,
      reader: MemoryReader(values: [
        file: Data(#"{"schemaVersion":2,"path":"/Applications/Pimpampum.app","managed":false}"#.utf8)
      ])
    )
    #expect(record?.url.path == "/Applications/Pimpampum.app")
    #expect(
      ApplicationLocationRecord.read(
        dataDirectory: dataDirectory, homeDirectory: home, reader: MemoryReader(values: [:])
      ) == nil)
  }

  @Test
  func infersTheSameLocationTheCLIAssumesWhenNoRecordExists() {
    let system = ApplicationLocationRecord.inferred(
      sourceApplicationURL: URL(fileURLWithPath: "/Applications/Pimpampum.app"),
      homeDirectory: home)
    #expect(system.url.path == "/Applications/Pimpampum.app")
    #expect(!system.managed)

    let user = ApplicationLocationRecord.inferred(
      sourceApplicationURL: URL(fileURLWithPath: "/Users/example/Applications/Pimpampum.app"),
      homeDirectory: home)
    #expect(!user.managed)
    #expect(user.url.path == "/Users/example/Applications/Pimpampum.app")

    let downloads = ApplicationLocationRecord.inferred(
      sourceApplicationURL: URL(fileURLWithPath: "/Users/example/Downloads/Pimpampum.app"),
      homeDirectory: home)
    #expect(downloads.managed)
    #expect(downloads.url.path == "/Users/example/Applications/Pimpampum.app")
    #expect(
      ApplicationLocationRecord.managedApplicationURL(homeDirectory: home).path
        == "/Users/example/Applications/Pimpampum.app")
  }

  @Test
  func canonicalBundlePathsIgnoreSymlinksAndPrivatePrefixes() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-canonical-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let real = root.appendingPathComponent("Real/Pimpampum.app", isDirectory: true)
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    let link = root.appendingPathComponent("Link")
    try FileManager.default.createSymbolicLink(
      at: link, withDestinationURL: root.appendingPathComponent("Real"))
    let throughLink = link.appendingPathComponent("Pimpampum.app", isDirectory: true)
    #expect(throughLink.canonicalBundleURL.path == real.canonicalBundleURL.path)
    #expect(ApplicationLocationRecord.currentSchemaVersion == 2)
    #expect(ApplicationLocationRecord.fileName == "application-path.json")
  }
}
