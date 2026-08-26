import SwiftUI

@MainActor
struct StatusIndicator: View {
  let state: StatusVisualState
  let activeCount: Int

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: state.symbolName)
        .foregroundStyle(state.color)
      if activeCount > 0 {
        Text(activeCount, format: .number)
          .monospacedDigit()
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  private var accessibilityLabel: String {
    let claims = activeCount == 1 ? "1 active claim" : "\(activeCount) active claims"
    return "Pimpampum: \(state.label), \(claims)"
  }
}

@MainActor
struct StatusPopover: View {
  @ObservedObject var store: OverviewStore
  let workspaceOpener: any WorkspaceOpening
  let loginItemState: LoginItemRegistrationState
  let openLoginSettings: () -> Void

  @State private var isCompletedExpanded = false
  @State private var revealError: String?

  init(
    store: OverviewStore,
    workspaceOpener: any WorkspaceOpening = WorkspaceOpener(),
    loginItemState: LoginItemRegistrationState = MainAppLoginItemService().state,
    openLoginSettings: @escaping () -> Void = {
      LoginApprovalSettings.open()
    }
  ) {
    self.store = store
    self.workspaceOpener = workspaceOpener
    self.loginItemState = loginItemState
    self.openLoginSettings = openLoginSettings
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
        .padding(16)

      Divider()

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          connectionNotice

          if loginItemState == .requiresApproval {
            loginApprovalNotice
          }

          if shouldShowOverview, let overview = store.overview {
            summary(for: overview)
            activeWorkSection(overview: overview)
            projectsSection(overview: overview)
          } else {
            unavailableContent()
          }

          if let revealError {
            inlineError(revealError)
          }
        }
        .padding(16)
      }
      .frame(maxHeight: 480)
    }
    .frame(width: 360)
    .background(.regularMaterial)
  }

  private var loginApprovalNotice: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("Login approval required", systemImage: "person.badge.key")
        .font(.subheadline.weight(.semibold))
      Text("Allow Pimpampum in Login Items to start it automatically.")
        .font(.caption)
        .foregroundStyle(.secondary)
      Button("Open Login Items Settings", action: openLoginSettings)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
  }

  private var visualState: StatusVisualState {
    Self.visualState(connectionState: store.connectionState, overview: store.overview)
  }

  private var shouldShowOverview: Bool {
    Self.shouldShowOverview(connectionState: store.connectionState, overview: store.overview)
  }

  private var visibleActiveCount: Int {
    Self.visibleActiveCount(
      connectionState: store.connectionState,
      overview: store.overview
    )
  }

  private var header: some View {
    HStack(spacing: 10) {
      StatusIndicator(state: visualState, activeCount: visibleActiveCount)

      VStack(alignment: .leading, spacing: 2) {
        Text("Pimpampum")
          .font(.headline)
        Text(visualState.label)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Spacer(minLength: 8)

      if let generatedAt = shouldShowOverview ? store.overview?.generatedAt : nil {
        Text(generatedAt, style: .relative)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .accessibilityLabel("Updated \(generatedAt.formatted(.relative(presentation: .named)))")
      }
    }
  }

  @ViewBuilder
  private var connectionNotice: some View {
    switch store.connectionState {
    case .loading:
      if store.overview == nil {
        notice(symbol: "hourglass", title: "Loading overview", detail: nil, color: .secondary)
      }
    case .online:
      EmptyView()
    case .offline(let message):
      notice(
        symbol: "wifi.slash",
        title: store.overview == nil ? "Pimpampum is offline" : "Offline — showing stale data",
        detail: message,
        color: .red
      )
    case .invalidToken(let message):
      notice(
        symbol: "lock.trianglebadge.exclamationmark",
        title: "Authentication error",
        detail: message,
        color: .red
      )
    case .incompatible(let message):
      notice(
        symbol: "exclamationmark.triangle.fill",
        title: "Incompatible overview version",
        detail: message,
        color: .red
      )
    }
  }

  private func summary(for overview: Overview) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionTitle("Summary")
      Text(Self.summaryText(overview.counts))
        .font(.subheadline)
      Text(
        "Daemon \(overview.daemon.version) · \(Self.uptimeText(overview.daemon.uptimeSeconds)) uptime"
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }

  private func activeWorkSection(overview: Overview) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionTitle("Active work")

      if store.visibleActiveWork.isEmpty {
        Text("No active work")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else {
        ForEach(store.visibleActiveWork) { work in
          activeWorkRow(work)
        }
      }

      if overview.activeWorkTruncated {
        truncationNotice("Active work is truncated. Refine the project set to see more.")
      }
    }
  }

  private func projectsSection(overview: Overview) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionTitle("Projects")

      if store.incompleteProjects.isEmpty, store.completedProjects.isEmpty {
        Text("No projects yet")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else {
        ForEach(store.incompleteProjects) { project in
          projectButton(project)
        }

        if !store.completedProjects.isEmpty {
          DisclosureGroup(isExpanded: $isCompletedExpanded) {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(store.completedProjects) { project in
                projectButton(project)
              }
            }
            .padding(.top, 8)
          } label: {
            Text("Completed (\(store.completedProjects.count))")
              .font(.subheadline.weight(.semibold))
          }
          .accessibilityHint("Collapsed by default. Expand to show completed projects.")
        }
      }

      if overview.projectsTruncated {
        truncationNotice("The project list is truncated. Counts still include every project.")
      }
    }
  }

  private func activeWorkRow(_ work: OverviewActiveWork) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(work.title)
        .font(.subheadline.weight(.medium))
        .lineLimit(2)

      if work.taskTitle != nil {
        Text(work.projectTitle)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      HStack(spacing: 10) {
        Label(work.agentId, systemImage: "person.crop.circle")
        Label(
          Self.leaseRemainingText(work.remainingSeconds(at: store.currentDate)),
          systemImage: "timer"
        )
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    .accessibilityElement(children: .combine)
  }

  private func projectButton(_ project: OverviewProject) -> some View {
    Button {
      do {
        try workspaceOpener.openWorkspace(at: project.workspace.rootPath)
        revealError = nil
      } catch {
        revealError = "\(project.title): \(error.localizedDescription)"
      }
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: Self.projectSymbol(project.status))
          .foregroundStyle(Self.projectColor(project.status))
          .frame(width: 16)
          .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 3) {
          Text(project.title)
            .font(.subheadline.weight(.medium))
            .lineLimit(2)

          Text("\(project.workspace.name) · \(project.slug)")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)

          Text(Self.projectCountsText(project))
            .font(.caption2)
            .foregroundStyle(.secondary)
        }

        Spacer(minLength: 4)

        Image(systemName: "arrow.up.forward.app")
          .font(.caption)
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Open \(project.title) in Finder")
    .accessibilityValue(Self.projectAccessibilityValue(project))
    .accessibilityHint("Opens workspace \(project.workspace.name)")
  }

  private func unavailableContent() -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Status unavailable")
        .font(.headline)
      Text("No project data is shown until a compatible authenticated overview is available.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }

  private func notice(
    symbol: String,
    title: String,
    detail: String?,
    color: Color
  ) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: symbol)
        .foregroundStyle(color)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.subheadline.weight(.semibold))
        if let detail, !detail.isEmpty {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(3)
        }
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    .accessibilityElement(children: .combine)
  }

  private func inlineError(_ message: String) -> some View {
    notice(
      symbol: "folder.badge.questionmark",
      title: "Workspace could not be opened",
      detail: message,
      color: .red
    )
  }

  private func truncationNotice(_ message: String) -> some View {
    Label(message, systemImage: "ellipsis.circle")
      .font(.caption)
      .foregroundStyle(.secondary)
      .accessibilityLabel(message)
  }

  private func sectionTitle(_ title: String) -> some View {
    Text(title)
      .font(.caption.weight(.semibold))
      .foregroundStyle(.secondary)
      .textCase(.uppercase)
      .accessibilityAddTraits(.isHeader)
  }

}
