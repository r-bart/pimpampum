import Foundation
import Testing

@testable import PimpampumMenuBar

struct ModelsTests {
  @Test
  func activeWorkUsesTheSpecTitleWhenNoTaskExists() {
    let work = OverviewActiveWork(
      targetType: .spec,
      targetId: "spec",
      workspaceId: "workspace",
      projectId: "project",
      projectTitle: "Project title",
      specId: "spec",
      specTitle: "Spec title",
      taskId: nil,
      taskTitle: nil,
      agentId: "agent",
      expiresAt: Date.distantFuture
    )

    #expect(work.title == "Spec title")
  }
}
