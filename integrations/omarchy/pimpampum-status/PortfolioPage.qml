import QtQuick
import qs.Commons

// The portfolio view: the guided agents card, connection notices, the empty state with the
// workspace action, active work, specs in progress, projects, and the collapsed completed and
// cancelled histories. StatusPopout loads it while neither settings nor help is showing.
// `controller` is the PopoutController that owns every flag and action the rows call.
Column {
  id: root

  required property var controller
  required property var service
  required property var connectionService
  required property color foreground
  required property color background
  required property color accent
  required property color urgent
  required property string fontFamily

  readonly property var projects: service.overview ? service.overview.projects : []
  readonly property var activeWork: service.overview ? service.overview.activeWork : []
  readonly property var specs: service.overview ? service.overview.specs : []
  readonly property var inProgressSpecs: specs.filter(function(spec) {
    return spec.lifecycleState === "ready" && spec.projectLifecycleState === "open"
  })
  readonly property var completedSpecs: specs.filter(function(spec) {
    return spec.lifecycleState === "done"
  })
  readonly property var incompleteProjects: projects.filter(function(project) {
    return project.lifecycleState !== "done" && project.lifecycleState !== "cancelled"
  })
  readonly property var completedProjects: projects.filter(function(project) {
    return project.lifecycleState === "done"
  })
  readonly property var cancelledProjects: projects.filter(function(project) {
    return project.lifecycleState === "cancelled"
  })
  // The guided card shows while a detected agent is still waiting for a decision; these states
  // need none.
  readonly property var settledAgentStates: [
    vocabulary.agentStateLabels.notInstalled,
    vocabulary.agentStateLabels.unsupportedVersion,
    vocabulary.agentStateLabels.connected,
    vocabulary.agentStateLabels.newSessionRequired
  ]
  readonly property bool showGuidedAgents: connectionService.initialized
    && (settledAgentStates.indexOf(connectionService.codexState) === -1
      || settledAgentStates.indexOf(connectionService.claudeCodeState) === -1)

  spacing: Style.space(10)

  StateVocabulary { id: vocabulary }

  AgentsSettingsCard {
    visible: root.showGuidedAgents
    width: parent.width
    guided: true
    service: root.connectionService
    foreground: root.foreground
    background: root.background
    accent: root.accent
    urgent: root.urgent
    fontFamily: root.fontFamily
  }

  Text {
    visible: root.service.connectionState !== "online"
      && root.service.connectionState !== "credentials"
    width: parent.width
    wrapMode: Text.Wrap
    maximumLineCount: 3
    elide: Text.ElideRight
    text: root.service.errorMessage
    color: root.urgent
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Item {
    visible: root.service.connectionState === "credentials"
    width: parent.width
    height: credentialsState.implicitHeight + Style.space(16)

    Column {
      id: credentialsState
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(8)

      Column {
        width: parent.width
        spacing: Style.space(3)

        Text {
          text: "Authentication required"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Text {
          width: parent.width
          wrapMode: Text.Wrap
          text: root.service.errorMessage
          color: root.foreground
          opacity: 0.72
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      Rectangle {
        width: parent.width
        height: credentialsCommand.implicitHeight + Style.space(14)
        radius: Style.space(4)
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.07)
        border.width: 1
        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

        Text {
          id: credentialsCommand
          anchors.left: parent.left
          anchors.leftMargin: Style.space(10)
          anchors.right: parent.right
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          wrapMode: Text.WrapAnywhere
          text: "pimpampum install"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }
    }
  }

  Text {
    visible: controller.revealError !== ""
    width: parent.width
    wrapMode: Text.Wrap
    maximumLineCount: 3
    elide: Text.ElideRight
    text: controller.revealError
    color: root.urgent
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  // A first run is not an error report: headline, one line of explanation, and the
  // command that resolves it on its own surface, so the shell verb is never read as
  // prose. The wrapper adds the breathing room a lone Text could not take from the
  // column spacing.
  Item {
    visible: root.service.overview && root.service.overview.counts.projects === 0
    width: parent.width
    height: emptyState.implicitHeight + Style.space(16)

    Column {
      id: emptyState
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      // Headline and explanation are one unit at the tight inner spacing; the command
      // is a separate affordance and gets the wider outer gap.
      spacing: Style.space(8)

      readonly property bool noWorkspaces:
        root.service.overview && root.service.overview.counts.workspaces === 0

      Column {
        width: parent.width
        spacing: Style.space(3)

        Text {
          text: emptyState.noWorkspaces ? "No workspaces" : "No projects"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Text {
          width: parent.width
          wrapMode: Text.Wrap
          text: emptyState.noWorkspaces
            ? "Register a folder as a workspace to start tracking projects."
            : "Projects appear here as your agents create them."
          color: root.foreground
          opacity: 0.72
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      // The folder dialog registers the first workspace without a terminal (D-01). The
      // dialog is the same isolated GTK helper the backup and sync cards use.
      PimpampumSettingsButton {
        id: addWorkspaceAction
        visible: emptyState.noWorkspaces && controller.folderDialogAvailable
        width: parent.width
        height: implicitHeight
        primary: true
        label: controller.registeringWorkspace ? "Adding workspace…" : "Add a workspace"
        foreground: root.foreground; background: root.background
        accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
        actionEnabled: !controller.registeringWorkspace && !controller.folderDialogOpen
        onTriggered: controller.chooseDirectory("workspace")
      }

      Text {
        visible: emptyState.noWorkspaces && controller.workspaceRegistrationNotice !== ""
        width: parent.width
        wrapMode: Text.Wrap
        text: controller.workspaceRegistrationNotice
        color: root.foreground
        opacity: 0.72
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Text {
        visible: emptyState.noWorkspaces && controller.workspaceRegistrationError !== ""
        width: parent.width
        wrapMode: Text.Wrap
        maximumLineCount: 3
        elide: Text.ElideRight
        text: controller.workspaceRegistrationError
        color: root.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      // A translucent foreground fill composites over whatever popup background the
      // theme paints, so one value works light and dark. The command wraps rather
      // than elides: a truncated command is worse than a taller card. It names the
      // receipt-owned launcher by its absolute path, because nothing puts it on PATH.
      Rectangle {
        visible: emptyState.noWorkspaces
        width: parent.width
        height: emptyCommand.implicitHeight + Style.space(14)
        radius: Style.space(4)
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.07)
        border.width: 1
        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

        Text {
          id: emptyCommand
          anchors.left: parent.left
          anchors.leftMargin: Style.space(10)
          anchors.right: parent.right
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          wrapMode: Text.WrapAnywhere
          text: controller.controlLauncherPath + " workspace:add <id> <name> /absolute/folder"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }
    }
  }

  Text {
    visible: root.activeWork.length > 0
    text: "Active work (" + root.activeWork.length + ")"
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    font.bold: true
  }

  Repeater {
    model: root.activeWork

    delegate: Column {
      required property var modelData
      width: root.width
      spacing: Style.space(1)

      Text {
        width: parent.width
        elide: Text.ElideRight
        text: modelData.taskTitle ? modelData.taskTitle : modelData.specTitle
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        elide: Text.ElideRight
        text: modelData.projectTitle
          + (modelData.taskTitle ? " · " + modelData.specTitle : "")
          + " · " + modelData.agentId + " · " + controller.leaseRemaining(modelData.expiresAt)
        color: root.foreground
        opacity: 0.72
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  Text {
    visible: root.service.overview && root.service.overview.activeWorkTruncated
    text: "Active work list truncated"
    color: root.urgent
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  Text {
    visible: root.inProgressSpecs.length > 0
    text: "Specs in progress (" + root.inProgressSpecs.length + ")"
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    font.bold: true
  }

  Repeater {
    model: root.inProgressSpecs

    delegate: PortfolioRow {
      required property var modelData
      width: root.width
      foreground: root.foreground
      fontFamily: root.fontFamily
      title: modelData.title
      subtitle: modelData.projectTitle + " · " + modelData.completedTaskCount
        + "/" + modelData.taskCount + " tasks"
        + (modelData.activeClaimCount > 0 ? " · active" : "")
      accessibleName: "Open " + modelData.title + " from " + modelData.projectTitle
      onActivated: controller.openWorkspace(modelData.workspace.rootPath)
    }
  }

  Text {
    visible: root.service.overview && root.service.overview.specsTruncated
    text: "Spec list truncated"
    color: root.urgent
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  Text {
    visible: root.incompleteProjects.length > 0
    text: "Projects (" + root.incompleteProjects.length + ")"
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    font.bold: true
  }

  Repeater {
    model: root.incompleteProjects

    delegate: PortfolioRow {
      required property var modelData
      width: root.width
      verticalPadding: Style.space(12)
      foreground: root.foreground
      fontFamily: root.fontFamily
      title: modelData.title + " · " + modelData.status
      subtitle: modelData.workspace.name + " / " + modelData.slug
        + " · " + modelData.activeClaimCount + " active"
        + " · " + modelData.availableWorkCount + " available"
      accessibleName: "Open " + modelData.title + " in " + modelData.workspace.name
      onActivated: controller.openWorkspace(modelData.workspace.rootPath)
    }
  }

  Text {
    visible: root.service.overview && root.service.overview.projectsTruncated
    text: "Project list truncated"
    color: root.urgent
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  DisclosureRow {
    visible: root.completedSpecs.length > 0
    width: parent.width
    foreground: root.foreground
    fontFamily: root.fontFamily
    title: "Completed specs (" + root.completedSpecs.length + ")"
    expanded: controller.completedExpanded
    onToggled: controller.toggleCompleted()
  }

  Repeater {
    model: controller.completedExpanded ? root.completedSpecs : []

    delegate: PortfolioRow {
      required property var modelData
      width: root.width
      foreground: root.foreground
      fontFamily: root.fontFamily
      title: modelData.title + " · " + modelData.projectTitle
      accessibleName: "Open " + modelData.title + " from " + modelData.projectTitle
      onActivated: controller.openWorkspace(modelData.workspace.rootPath)
    }
  }

  DisclosureRow {
    visible: root.cancelledProjects.length > 0
    width: parent.width
    foreground: root.foreground
    fontFamily: root.fontFamily
    title: "Cancelled (" + root.cancelledProjects.length + ")"
    expanded: controller.cancelledExpanded
    onToggled: controller.toggleCancelled()
  }

  Repeater {
    model: controller.cancelledExpanded ? root.cancelledProjects : []

    delegate: PortfolioRow {
      required property var modelData
      width: root.width
      foreground: root.foreground
      fontFamily: root.fontFamily
      titleOpacity: 0.72
      title: modelData.title + " · Cancelled · "
        + modelData.workspace.name + " / " + modelData.slug
      accessibleName: "Open cancelled project " + modelData.title
        + " in " + modelData.workspace.name
      onActivated: controller.openWorkspace(modelData.workspace.rootPath)
    }
  }
}
