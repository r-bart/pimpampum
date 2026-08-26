import Foundation
import Testing

@testable import PimpampumMenuBar

struct ModelsTests {
  @Test
  func activeWorkFallsBackToItsProjectTitle() {
    let work = OverviewActiveWork(
      targetType: .project,
      targetId: "project",
      workspaceId: "workspace",
      projectId: "project",
      projectTitle: "Project title",
      taskId: nil,
      taskTitle: nil,
      agentId: "agent",
      expiresAt: Date.distantFuture
    )

    #expect(work.title == "Project title")
  }
}
