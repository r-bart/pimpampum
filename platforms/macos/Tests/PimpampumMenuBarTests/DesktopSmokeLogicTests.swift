import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite
struct DesktopSmokeLogicTests {
  @Test
  func parsesOnlyCompleteSmokeRequestsAndOptionalValues() throws {
    #expect(try DesktopSmokeLogic.request(from: ["normal"]) == nil)
    #expect(throws: DesktopSmokeError.missingOutputPaths) {
      try DesktopSmokeLogic.request(from: ["--ui-smoke-snapshot"])
    }

    let minimal = try #require(
      try DesktopSmokeLogic.request(from: ["--ui-smoke-snapshot", "/tmp/state.json", "/tmp/ui.png"])
    )
    #expect(minimal.seedURL == nil)
    #expect(minimal.projectId == nil)

    let complete = try #require(
      try DesktopSmokeLogic.request(from: [
        "--ui-smoke-snapshot", "/tmp/state.json", "/tmp/ui.png",
        "--seed-overview", "/tmp/seed.json", "--open-project", "project-1",
      ])
    )
    #expect(complete.seedURL?.path == "/tmp/seed.json")
    #expect(complete.projectId == "project-1")

    let dangling = try #require(
      try DesktopSmokeLogic.request(from: [
        "--ui-smoke-snapshot", "/tmp/state.json", "/tmp/ui.png", "--open-project",
      ])
    )
    #expect(dangling.projectId == nil)
  }

  @Test
  func decodesFractionalAndStandardDatesAndRejectsInvalidDates() throws {
    let payload = try overviewPayload(try fixtureData("mixed"))
    let fractional = try DesktopSmokeLogic.decodeOverview(payload)
    #expect(fractional.status == .active)

    let standardData = payload.replacingOccurrences(
      of: Data(".000Z".utf8),
      with: Data("Z".utf8)
    )
    let standard = try DesktopSmokeLogic.decodeOverview(standardData)
    #expect(standard.status == .active)

    let invalidData = payload.replacingOccurrences(
      of: Data("2026-08-26T20:01:30.000Z".utf8),
      with: Data("not-a-date".utf8)
    )
    #expect(throws: (any Error).self) {
      try DesktopSmokeLogic.decodeOverview(invalidData)
    }
  }

  @Test
  func selectsExactProjectOrReportsItMissing() throws {
    let project = testProject(id: "project-1", status: .active, updatedAt: .now)
    let overview = testOverview(projects: [project])
    #expect(try DesktopSmokeLogic.project(withId: "project-1", in: overview) == project)
    #expect(throws: DesktopSmokeError.projectMissing("missing")) {
      try DesktopSmokeLogic.project(withId: "missing", in: overview)
    }
  }

  @Test
  func labelsEveryConnectionStateAndBuildsStableSnapshot() {
    #expect(DesktopSmokeLogic.connectionLabel(.loading) == "loading")
    #expect(DesktopSmokeLogic.connectionLabel(.online) == "online")
    #expect(DesktopSmokeLogic.connectionLabel(.offline("down")) == "offline")
    #expect(DesktopSmokeLogic.connectionLabel(.invalidToken("bad")) == "credentials")
    #expect(DesktopSmokeLogic.connectionLabel(.incompatible("new")) == "incompatible")

    let complete = testProject(id: "complete", status: .complete, updatedAt: .now)
    let active = testProject(id: "active", status: .active, updatedAt: .now)
    let snapshot = DesktopSmokeLogic.snapshot(
      overview: testOverview(projects: [complete, active]),
      visualState: .active,
      activeCount: 2,
      connectionState: .online,
      stale: false,
      png: Data("png".utf8),
      accessibilityLabels: ["Zulu", "Alpha"],
      activatedControlLabel: "Open active in Finder",
      openedWorkspacePath: "/tmp/workspace"
    )
    #expect(snapshot.schemaVersion == 1)
    #expect(snapshot.accessibilityLabel == "Pimpampum: Active, 2 active claims")
    #expect(snapshot.accessibilityLabels == ["Alpha", "Zulu"])
    #expect(snapshot.projectRows.map(\.id) == ["complete", "active"])
    #expect(snapshot.renderedPngSha256.count == 64)
    #expect(snapshot.activatedControlLabel == "Open active in Finder")

    let singular = DesktopSmokeLogic.snapshot(
      overview: nil,
      visualState: .active,
      activeCount: 1,
      connectionState: .online,
      stale: false,
      png: Data(),
      accessibilityLabels: [],
      activatedControlLabel: nil,
      openedWorkspacePath: nil
    )
    #expect(singular.accessibilityLabel == "Pimpampum: Active, 1 active claim")

    let empty = DesktopSmokeLogic.snapshot(
      overview: nil,
      visualState: .empty,
      activeCount: 0,
      connectionState: .loading,
      stale: true,
      png: Data(),
      accessibilityLabels: [],
      activatedControlLabel: nil,
      openedWorkspacePath: nil
    )
    #expect(empty.projectRows.isEmpty)
  }

  @Test
  func smokeErrorsHaveActionableDescriptions() {
    let errors: [DesktopSmokeError] = [
      .missingOutputPaths,
      .invalidSeed,
      .projectMissing("p"),
      .renderedControlMissing("button"),
      .renderedControlActivationFailed("button"),
      .renderFailed,
    ]
    #expect(errors.allSatisfy { !($0.errorDescription ?? "").isEmpty })
  }
}

extension Data {
  fileprivate func replacingOccurrences(of target: Data, with replacement: Data) -> Data {
    var result = self
    while let range = result.range(of: target) {
      result.replaceSubrange(range, with: replacement)
    }
    return result
  }
}

private func overviewPayload(_ envelope: Data) throws -> Data {
  let root = try #require(JSONSerialization.jsonObject(with: envelope) as? [String: Any])
  return try JSONSerialization.data(withJSONObject: try #require(root["data"]))
}
