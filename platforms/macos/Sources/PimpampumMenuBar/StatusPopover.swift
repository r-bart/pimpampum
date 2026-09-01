import AppKit
import SwiftUI

enum GuidedSetupRecoveryCopy {
  static let retry = "Try again"
  static let newSession = "Open a new agent session to use shared project memory."
}

@MainActor
struct StatusIndicator: View {
  let state: StatusVisualState
  let activeCount: Int
  var showsActiveCount = true

  var body: some View {
    HStack(spacing: 4) {
      ZStack(alignment: .bottomTrailing) {
        PimpampumMark()
          .foregroundStyle(.primary)
        if !showsActiveCount || StatusIndicatorPresentation.displayCount(activeCount) == nil {
          PimpampumStatusBadge(kind: state.badgeKind, color: state.color)
            .offset(x: 3, y: 2)
        }
      }
      .frame(width: 17, height: 16, alignment: .leading)

      if showsActiveCount,
        let displayCount = StatusIndicatorPresentation.displayCount(activeCount)
      {
        Text(displayCount)
          .monospacedDigit()
          .foregroundStyle(state.color)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      StatusIndicatorPresentation.accessibilityLabel(state: state, activeCount: activeCount)
    )
    .help(StatusIndicatorPresentation.accessibilityLabel(state: state, activeCount: activeCount))
  }
}

@MainActor
struct StatusPopover: View {
  @ObservedObject var store: OverviewStore
  @ObservedObject var setupSession: SetupSession
  let workspaceOpener: any WorkspaceOpening
  let loginItemState: LoginItemRegistrationState
  let openLoginSettings: () -> Void
  let settingsWindowOpener: any SettingsWindowOpening
  let setupAssistant: SetupAssistant
  let workspaceFolderPicker: any WorkspaceFolderPicking
  let quitApplication: () -> Void

  @State private var isCompletedExpanded = false
  @State private var isCancelledExpanded = false
  @State private var isCompletedSpecsExpanded = false
  @State private var isInProgressSpecsExpanded = true
  @State private var isProjectsExpanded = true
  @State private var isHelpPresented = false
  @State private var revealError: String?

  init(
    store: OverviewStore,
    setupSession: SetupSession? = nil,
    workspaceOpener: any WorkspaceOpening = WorkspaceOpener(),
    loginItemState: LoginItemRegistrationState = MainAppLoginItemService().state,
    openLoginSettings: @escaping () -> Void = {
      LoginApprovalSettings.open()
    },
    settingsWindowOpener: any SettingsWindowOpening = SettingsWindowOpener(),
    setupAssistant: SetupAssistant = SetupAssistant(),
    workspaceFolderPicker: any WorkspaceFolderPicking = WorkspaceFolderPicker(),
    quitApplication: @escaping () -> Void = { NSApplication.shared.terminate(nil) }
  ) {
    self.store = store
    self.setupSession = setupSession ?? SetupSession.bundled(overviewStore: store)
    self.workspaceOpener = workspaceOpener
    self.loginItemState = loginItemState
    self.openLoginSettings = openLoginSettings
    self.settingsWindowOpener = settingsWindowOpener
    self.setupAssistant = setupAssistant
    self.workspaceFolderPicker = workspaceFolderPicker
    self.quitApplication = quitApplication
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
        .padding(16)

      Divider()

      switch content {
      case .help:
        // Rendered inside the popover, never in a sheet. A sheet is a real window and the menu-bar
        // popover closes the moment it loses key focus, taking the popover down with it.
        ScrollView {
          HelpDialog { isHelpPresented = false }
            .padding(20)
        }
      case .guidedSetup:
        // The session, not this branch, owns the setup store and the current step, so a poll or
        // the help button re-entering here finds the setup where it was.
        SetupOnboardingView(session: setupSession)
          .padding(20)
      case .overview:
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 16) {
            connectionNotice

            if loginItemState != .enabled {
              loginApprovalNotice
            }

            if shouldShowOverview, let overview = store.overview {
              summary(for: overview)
              activeWorkSection(overview: overview)
              specsInProgressSection(overview: overview)
              projectsSection(overview: overview)
              completedSpecsSection
            } else {
              unavailableContent()
            }

            if let revealError {
              inlineError(revealError)
            }
          }
          .padding(16)
        }
        .frame(maxHeight: Self.bodyMaximumHeight)
        .fixedSize(horizontal: false, vertical: true)
      }

      Divider()

      HStack {
        Button(PimpampumBrand.quitTitle, action: quitApplication)
          .buttonStyle(.plain)
        Spacer()
        if !Self.showsSettingsButton(content: content) {
          Text(PimpampumBrand.versionText())
            .foregroundStyle(.secondary)
        } else {
          Button {
            settingsWindowOpener.openSettings()
          } label: {
            Label("Settings…", systemImage: "gearshape")
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
    }
    .frame(width: Self.containerWidth)
    .background(.regularMaterial)
  }

  private var loginApprovalNotice: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(
        loginItemState == .requiresApproval ? "Login approval required" : "Start at login",
        systemImage: "person.badge.key"
      )
      .font(.subheadline.weight(.semibold))
      Text(
        loginItemState == .requiresApproval
          ? "Allow \(PimpampumBrand.displayName) in Login Items to start it automatically."
          : "Add \(PimpampumBrand.displayName) to Login Items so the menu stays available after a restart."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      if loginItemState == .requiresApproval {
        Button("Open Login Items Settings", action: openLoginSettings)
      } else {
        Button("Start at Login", action: setupAssistant.prepareApp)
      }
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

  private var content: StatusPopoverContent {
    Self.content(
      isHelpPresented: isHelpPresented,
      setupSessionActive: setupSession.isActive,
      connectionState: store.connectionState
    )
  }

  private var visibleActiveCount: Int {
    Self.visibleActiveCount(
      connectionState: store.connectionState,
      overview: store.overview
    )
  }

  private var header: some View {
    HStack(spacing: 10) {
      StatusIndicator(
        state: visualState,
        activeCount: visibleActiveCount,
        showsActiveCount: false
      )

      VStack(alignment: .leading, spacing: 2) {
        Text(PimpampumBrand.displayName)
          .font(.headline)
        Text(visualState.label)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Spacer(minLength: 8)

      if Self.showsHelpButton(setupSessionActive: setupSession.isActive) {
        Button {
          isHelpPresented = true
        } label: {
          Image(systemName: "questionmark.circle")
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .frame(width: 24, height: 24)
        .contentShape(Rectangle())
        .accessibilityLabel(HelpDialogCopy.buttonTitle)
        .help(HelpDialogCopy.buttonTitle)
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
    case .setupRequired:
      EmptyView()
    case .offline(let message):
      notice(
        symbol: "wifi.slash",
        title: store.overview == nil
          ? "\(PimpampumBrand.displayName) is offline" : "Offline — showing stale data",
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
    VStack(alignment: .leading, spacing: 0) {
      collapsibleSectionTitle(
        "Projects (\(overview.counts.projects))",
        isExpanded: $isProjectsExpanded,
        uppercase: true
      )

      if isProjectsExpanded {
        VStack(alignment: .leading, spacing: 8) {
          if store.incompleteProjects.isEmpty, store.completedProjects.isEmpty,
            store.cancelledProjects.isEmpty
          {
            emptyProjects(overview: overview)
          } else {
            ForEach(store.incompleteProjects) { project in
              projectButton(project)
            }

            if !store.completedProjects.isEmpty {
              VStack(alignment: .leading, spacing: 0) {
                collapsibleSectionTitle(
                  "Completed (\(store.completedProjects.count))",
                  isExpanded: $isCompletedExpanded
                )

                if isCompletedExpanded {
                  VStack(alignment: .leading, spacing: 8) {
                    ForEach(store.completedProjects) { project in
                      projectButton(project)
                    }
                  }
                  .padding(.top, 8)
                }
              }
            }

            if !store.cancelledProjects.isEmpty {
              VStack(alignment: .leading, spacing: 0) {
                collapsibleSectionTitle(
                  "Cancelled (\(store.cancelledProjects.count))",
                  isExpanded: $isCancelledExpanded
                )

                if isCancelledExpanded {
                  VStack(alignment: .leading, spacing: 8) {
                    ForEach(store.cancelledProjects) { project in
                      projectButton(project)
                    }
                  }
                  .padding(.top, 8)
                }
              }
            }
          }

          if overview.projectsTruncated {
            truncationNotice("The project list is truncated. Counts still include every project.")
          }
        }
        .padding(.top, 8)
      }
    }
  }

  @ViewBuilder
  private func specsInProgressSection(overview: Overview) -> some View {
    if !store.inProgressSpecs.isEmpty || overview.specsTruncated {
      VStack(alignment: .leading, spacing: 0) {
        collapsibleSectionTitle(
          "Specs in progress (\(store.inProgressSpecs.count))",
          isExpanded: $isInProgressSpecsExpanded,
          uppercase: true
        )

        if isInProgressSpecsExpanded {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(store.inProgressSpecs) { spec in
              specButton(spec)
            }

            if overview.specsTruncated {
              truncationNotice("The spec list is truncated. Counts still include every spec.")
            }
          }
          .padding(.top, 8)
        }
      }
    }
  }

  @ViewBuilder
  private var completedSpecsSection: some View {
    if !store.completedSpecs.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        collapsibleSectionTitle(
          "Completed specs (\(store.completedSpecs.count))",
          isExpanded: $isCompletedSpecsExpanded
        )

        if isCompletedSpecsExpanded {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(store.completedSpecs) { spec in
              specButton(spec)
            }
          }
          .padding(.top, 8)
        }
      }
    }
  }

  private func activeWorkRow(_ work: OverviewActiveWork) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(work.title)
        .font(.subheadline.weight(.medium))
        .lineLimit(Self.contentTitleLineLimit)

      Text(
        work.taskTitle == nil
          ? work.projectTitle
          : "\(work.projectTitle) · \(work.specTitle)"
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .lineLimit(Self.metadataLineLimit)
      .truncationMode(.tail)

      Text(
        "\(work.agentId) · \(Self.leaseRemainingText(work.remainingSeconds(at: store.currentDate)))"
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    .accessibilityElement(children: .combine)
  }

  private func projectButton(_ project: OverviewProject) -> some View {
    ProjectRowButton(project: project) {
      do {
        try workspaceOpener.openWorkspace(at: project.workspace.rootPath)
        revealError = nil
      } catch {
        revealError = Self.workspaceRevealError(
          project,
          description: error.localizedDescription
        )
      }
    }
  }

  private func specButton(_ spec: OverviewSpec) -> some View {
    SpecRowButton(spec: spec) {
      do {
        try workspaceOpener.openWorkspace(at: spec.workspace.rootPath)
        revealError = nil
      } catch {
        revealError = Self.workspaceRevealError(
          spec,
          description: error.localizedDescription
        )
      }
    }
  }

  /// A first run is not an error: one line says why the list is empty and, with no workspace at
  /// all, the folder dialog registers the first one. The dialog is a real window the popover
  /// survives, exactly like the backup folder dialog.
  private func emptyProjects(overview: Overview) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("No projects yet")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      Text(Self.emptyProjectsDetail(overview: overview))
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if Self.showsAddWorkspace(overview: overview) {
        Button(WorkspaceRegistrationCopy.button) {
          Task { await setupSession.addWorkspace(using: workspaceFolderPicker) }
        }
        .buttonStyle(GuidedSecondaryButtonStyle())
        .disabled(setupSession.workspaceRegistration.isRegistering)
        .accessibilityLabel(WorkspaceRegistrationCopy.buttonAccessibilityLabel)
      }
      if let notice = setupSession.workspaceRegistration.notice {
        WorkspaceRegistrationNoticeRow(notice: notice)
      }
    }
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

  private func collapsibleSectionTitle(
    _ title: String,
    isExpanded: Binding<Bool>,
    uppercase: Bool = false
  ) -> some View {
    Button {
      isExpanded.wrappedValue.toggle()
    } label: {
      HStack(spacing: 8) {
        Text(title)
          .font(uppercase ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
          .foregroundStyle(uppercase ? Color.secondary : Color.primary)
          .textCase(uppercase ? .uppercase : nil)

        Spacer(minLength: 8)

        Image(systemName: isExpanded.wrappedValue ? "chevron.down" : "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityValue(isExpanded.wrappedValue ? "Expanded" : "Collapsed")
    .accessibilityHint(isExpanded.wrappedValue ? "Collapse section" : "Expand section")
  }

}

@MainActor
private struct ProjectRowButton: View {
  let project: OverviewProject
  let action: () -> Void

  @State private var isHovering = false

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 3) {
          Text(project.title)
            .font(.subheadline.weight(.medium))
            .lineLimit(StatusPopover.contentTitleLineLimit)

          Text(StatusPopover.projectMetadataText(project))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(StatusPopover.metadataLineLimit)
            .truncationMode(.tail)

          Text(StatusPopover.projectCountsText(project))
            .font(.caption2)
            .foregroundStyle(.secondary)
        }

        Spacer(minLength: 4)

      }
      .padding(.horizontal, 6)
      .padding(.vertical, 5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .background(
        isHovering ? Color.primary.opacity(0.06) : Color.clear,
        in: RoundedRectangle(cornerRadius: 6)
      )
    }
    .buttonStyle(.plain)
    .frame(maxWidth: .infinity, alignment: .leading)
    .onHover { isHovering = $0 }
    .accessibilityLabel(StatusPopover.projectOpenAccessibilityLabel(project))
    .accessibilityValue(StatusPopover.projectAccessibilityValue(project))
    .accessibilityHint(StatusPopover.projectOpenAccessibilityHint(project))
  }
}

@MainActor
private struct SpecRowButton: View {
  let spec: OverviewSpec
  let action: () -> Void

  @State private var isHovering = false

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 3) {
          Text(spec.title)
            .font(.subheadline.weight(.medium))
            .lineLimit(StatusPopover.contentTitleLineLimit)

          Text(StatusPopover.specMetadataText(spec))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(StatusPopover.metadataLineLimit)
            .truncationMode(.tail)
        }

        Spacer(minLength: 4)

      }
      .padding(.horizontal, 6)
      .padding(.vertical, 5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .background(
        isHovering ? Color.primary.opacity(0.06) : Color.clear,
        in: RoundedRectangle(cornerRadius: 6)
      )
    }
    .buttonStyle(.plain)
    .frame(maxWidth: .infinity, alignment: .leading)
    .onHover { isHovering = $0 }
    .accessibilityLabel(StatusPopover.specOpenAccessibilityLabel(spec))
    .accessibilityValue(StatusPopover.specAccessibilityValue(spec))
    .accessibilityHint(StatusPopover.specOpenAccessibilityHint(spec))
  }
}
