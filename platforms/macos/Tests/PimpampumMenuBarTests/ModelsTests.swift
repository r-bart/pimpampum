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

  @Test
  func specExposesEveryBoundedCountForValidation() {
    let spec = testSpec(
      id: "spec",
      lifecycleState: .ready,
      updatedAt: Date(),
      taskCount: 5,
      completedTaskCount: 2,
      activeClaimCount: 1
    )

    #expect(spec.allCounts == [5, 3, 2, 1])
  }
}
