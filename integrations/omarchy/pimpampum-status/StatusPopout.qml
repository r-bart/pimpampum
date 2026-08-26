import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

Item {
  id: root

  required property var bar
  required property var anchorItem
  required property var service
  property bool opened: false
  property bool completedExpanded: false
  property string revealError: ""
  property string pendingWorkspacePath: ""

  readonly property color foreground: bar ? bar.foreground : "white"
  readonly property color background: bar ? bar.background : "#202020"
  readonly property color urgent: bar ? bar.urgent : "#ff5f57"
  readonly property string fontFamily: bar ? bar.fontFamily : "monospace"
  readonly property var projects: service.overview ? service.overview.projects : []
  readonly property var activeWork: service.overview ? service.overview.activeWork : []
  readonly property var incompleteProjects: projects.filter(function(project) {
    return project.status !== "complete"
  })
  readonly property var completedProjects: projects.filter(function(project) {
    return project.status === "complete"
  })

  function open() {
    if (opened) return
    opened = true
    service.refresh()
  }

  function close() {
    if (!opened) return
    opened = false
  }

  function toggle() {
    if (opened) close()
    else open()
  }

  function closeForPopoutSwitch() {
    close()
  }

  function isSafeWorkspacePath(path) {
    return typeof path === "string" && path.length > 1
      && path.charAt(0) === "/" && path.indexOf("\u0000") === -1
  }

  function openWorkspace(path) {
    revealError = ""
    if (!isSafeWorkspacePath(path)) return void (revealError = "Workspace path is unavailable")
    if (workspaceOpener.running) return void (revealError = "The file explorer is already opening a workspace")
    pendingWorkspacePath = path
    var arguments = ["xdg-open", path]
    workspaceOpener.command = arguments
    workspaceOpener.running = true
  }

  function leaseRemaining(expiresAt) {
    var seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - service.currentMs) / 1000))
    if (seconds < 60) return seconds + "s"
    return Math.ceil(seconds / 60) + "m"
  }

  Process {
    id: workspaceOpener
    command: ["xdg-open", root.pendingWorkspacePath]
    onExited: function(exitCode) {
      if (exitCode !== 0) root.revealError = "Could not open the workspace directory"
    }
  }

  PopupCard {
    id: popup
    anchorItem: root.anchorItem
    bar: root.bar
    owner: root
    // PopupCard maps this state to bar.requestPopout(owner) and
    // bar.releasePopout(owner), avoiding competing popup windows.
    open: root.opened
    contentWidth: fittedContentWidth(Style.space(380))
    contentHeight: fittedContentHeight(Math.min(content.implicitHeight, Style.space(520)))

    Flickable {
      anchors.fill: parent
      contentWidth: width
      contentHeight: content.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      Column {
        id: content
        width: parent.width
        spacing: Style.space(10)

        Row {
          width: parent.width
          spacing: Style.space(8)

          Text {
            text: "Pimpampum"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Text {
            text: root.service.stale ? "Stale" : root.service.connectionState
            color: root.service.connectionState === "online" ? root.foreground : root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        Text {
          visible: root.service.connectionState !== "online"
          width: parent.width
          wrapMode: Text.Wrap
          text: root.service.errorMessage
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          visible: root.revealError !== ""
          width: parent.width
          wrapMode: Text.Wrap
          text: root.revealError
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          visible: root.service.overview && root.service.overview.counts.projects === 0
          text: root.service.overview && root.service.overview.counts.workspaces === 0
            ? "No workspaces. Run: pimpampum workspace:add"
            : "No projects"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
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
            width: content.width
            spacing: Style.space(1)

            Text {
              width: parent.width
              elide: Text.ElideRight
              text: modelData.projectTitle + (modelData.taskTitle ? " — " + modelData.taskTitle : "")
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              text: modelData.agentId + " · " + root.leaseRemaining(modelData.expiresAt)
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
          visible: root.incompleteProjects.length > 0
          text: "Projects (" + root.incompleteProjects.length + ")"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Repeater {
          model: root.incompleteProjects

          delegate: Item {
            required property var modelData
            width: content.width
            height: projectText.implicitHeight + Style.space(12)

            Column {
              id: projectText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(1)

              Text {
                width: parent.width
                elide: Text.ElideRight
                text: modelData.title + " · " + modelData.status
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                width: parent.width
                elide: Text.ElideRight
                text: modelData.workspace.name + " / " + modelData.slug
                  + " · " + modelData.activeClaimCount + " active"
                  + " · " + modelData.availableWorkCount + " available"
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: openWorkspace(modelData.workspace.rootPath)
            }
          }
        }

        Text {
          visible: root.service.overview && root.service.overview.projectsTruncated
          text: "Project list truncated"
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Item {
          visible: root.completedProjects.length > 0
          width: parent.width
          height: completedTitle.implicitHeight + Style.space(8)

          Text {
            id: completedTitle
            anchors.verticalCenter: parent.verticalCenter
            text: (root.completedExpanded ? "▾ " : "▸ ")
              + "Completed (" + root.completedProjects.length + ")"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: root.completedExpanded = !root.completedExpanded
          }
        }

        Repeater {
          model: root.completedExpanded ? root.completedProjects : []

          delegate: Item {
            required property var modelData
            width: content.width
            height: completedText.implicitHeight + Style.space(10)

            Text {
              id: completedText
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width
              elide: Text.ElideRight
              text: modelData.title + " · " + modelData.workspace.name + " / " + modelData.slug
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onClicked: openWorkspace(modelData.workspace.rootPath)
            }
          }
        }
      }
    }
  }
}
