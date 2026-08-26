import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
@MainActor
struct WorkspaceOpenerTests {
  @Test
  func exposesActionableDescriptionsForEveryFailure() {
    let errors: [WorkspaceOpenError] = [
      .invalidPath,
      .unavailable(path: "/missing"),
      .openFailed(path: "/refused"),
    ]

    #expect(errors.allSatisfy { !($0.errorDescription ?? "").isEmpty })
  }

  @Test
  func opensOnlyAValidatedAbsoluteDirectoryURL() throws {
    var validatedPaths: [String] = []
    var openedURLs: [URL] = []
    let opener = WorkspaceOpener(
      validateDirectory: { path in
        validatedPaths.append(path)
        return true
      },
      openDirectory: { url in
        openedURLs.append(url)
        return true
      }
    )

    try opener.openWorkspace(at: "/Users/example/100 Projects/../100 Projects")

    let expected = URL(fileURLWithPath: "/Users/example/100 Projects", isDirectory: true)
      .standardizedFileURL
    #expect(validatedPaths == [expected.path])
    #expect(openedURLs == [expected])
    #expect(openedURLs.first?.isFileURL == true)
  }

  @Test(arguments: ["", "relative/project", "/valid\0suffix"])
  func rejectsInvalidPathsWithoutOpening(path: String) {
    var didValidate = false
    var didOpen = false
    let opener = WorkspaceOpener(
      validateDirectory: { _ in
        didValidate = true
        return true
      },
      openDirectory: { _ in
        didOpen = true
        return true
      }
    )

    #expect(throws: WorkspaceOpenError.invalidPath) {
      try opener.openWorkspace(at: path)
    }
    #expect(!didValidate)
    #expect(!didOpen)
  }

  @Test
  func reportsMissingOrInaccessibleDirectoriesWithoutOpening() {
    var didOpen = false
    let opener = WorkspaceOpener(
      validateDirectory: { _ in false },
      openDirectory: { _ in
        didOpen = true
        return true
      }
    )

    #expect(throws: WorkspaceOpenError.unavailable(path: "/missing/workspace")) {
      try opener.openWorkspace(at: "/missing/workspace")
    }
    #expect(!didOpen)
  }

  @Test
  func reportsFinderRefusalWithoutRetryingOrExecutingThePath() {
    var openedURLs: [URL] = []
    let opener = WorkspaceOpener(
      validateDirectory: { _ in true },
      openDirectory: { url in
        openedURLs.append(url)
        return false
      }
    )

    #expect(throws: WorkspaceOpenError.openFailed(path: "/Users/example/Project; touch pwned")) {
      try opener.openWorkspace(at: "/Users/example/Project; touch pwned")
    }
    #expect(openedURLs.map(\.path) == ["/Users/example/Project; touch pwned"])
  }

  @Test
  func productionValidatorAcceptsDirectoriesAndRejectsRegularFiles() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory
      .appendingPathComponent("pimpampum-opener-\(UUID().uuidString)", isDirectory: true)
    let file = root.appendingPathComponent("not-a-directory")
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    try Data("content".utf8).write(to: file)
    defer { try? fileManager.removeItem(at: root) }

    var opened: [URL] = []
    let opener = WorkspaceOpener(
      fileManager: fileManager,
      openDirectory: { url in
        opened.append(url)
        return true
      }
    )

    try opener.openWorkspace(at: root.path)
    #expect(opened == [root.standardizedFileURL])
    #expect(throws: WorkspaceOpenError.unavailable(path: file.standardizedFileURL.path)) {
      try opener.openWorkspace(at: file.path)
    }
  }
}
