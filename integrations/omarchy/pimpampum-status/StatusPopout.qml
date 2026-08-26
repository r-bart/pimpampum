import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

Item {
  id: root

  required property var bar
  required property var anchorItem
  required property var service
  required property var backupService
  property bool opened: false
  property bool completedExpanded: false
  property bool cancelledExpanded: false
  property bool backupExpanded: false
  property string manualBackupDirectory: ""
  property var backupFolderDialog: null
  property bool folderDialogChecked: false
  property bool folderDialogAvailable: false
  property string revealError: ""
  property string pendingWorkspacePath: ""

  readonly property color foreground: bar ? bar.foreground : "white"
  readonly property color background: bar ? bar.background : "#202020"
  readonly property color urgent: bar ? bar.urgent : "#ff5f57"
  readonly property string fontFamily: bar ? bar.fontFamily : "monospace"
  readonly property var projects: service.overview ? service.overview.projects : []
  readonly property var activeWork: service.overview ? service.overview.activeWork : []
  readonly property var incompleteProjects: projects.filter(function(project) {
    return project.lifecycleState !== "done" && project.lifecycleState !== "cancelled"
  })
  readonly property var completedProjects: projects.filter(function(project) {
    return project.lifecycleState === "done"
  })
  readonly property var cancelledProjects: projects.filter(function(project) {
    return project.lifecycleState === "cancelled"
  })

  function open() {
    if (opened) return
    opened = true
    service.refresh()
    backupService.refresh()
  }

  function localPath(fileUrl) {
    var encoded = String(fileUrl)
    if (encoded.indexOf("file://") !== 0) return ""
    var path = decodeURIComponent(encoded.slice(7))
    return backupService.isAbsolutePath(path) ? path : ""
  }

  function ensureFolderDialog() {
    if (folderDialogChecked) return folderDialogAvailable
    folderDialogChecked = true
    try {
      var source = 'import QtQuick; import QtQuick.Dialogs; '
        + 'FolderDialog { title: "Choose a backup folder" }'
      backupFolderDialog = Qt.createQmlObject(source, root, "PimpampumBackupFolderDialog")
      backupFolderDialog.accepted.connect(function() {
        var path = root.localPath(backupFolderDialog.selectedFolder)
        if (path === "") {
          backupService.operationError = "The selected backup folder is unavailable"
          return
        }
        root.manualBackupDirectory = path
        backupService.configure(path)
      })
      folderDialogAvailable = true
    } catch (error) {
      backupFolderDialog = null
      folderDialogAvailable = false
    }
    return folderDialogAvailable
  }

  function chooseBackupDirectory() {
    if (ensureFolderDialog()) backupFolderDialog.open()
  }

  function backupStatusText() {
    if (backupService.busy) return "Updating…"
    if (backupService.backupState === "disabled") return "Automatic backup is off"
    if (backupService.backupState === "pending") return "Backup pending"
    if (backupService.backupState === "error") return "Backup needs attention"
    if (backupService.lastSuccessAt === "") return "Up to date"
    return "Up to date · " + new Date(backupService.lastSuccessAt).toLocaleTimeString()
  }

  function toggleCompleted() {
    completedExpanded = !completedExpanded
  }

  function toggleCancelled() {
    cancelledExpanded = !cancelledExpanded
  }

  function toggleBackup() {
    backupExpanded = !backupExpanded
    if (!backupExpanded) return
    manualBackupDirectory = backupService.directory
    ensureFolderDialog()
    backupService.refresh()
  }

  function runBackupAction(action) {
    if (action === "choose") chooseBackupDirectory()
    else if (action === "save") backupService.configure(manualBackupDirectory)
    else if (action === "open") backupService.openDirectory()
    else if (action === "retry") backupService.retry()
    else if (action === "disable") backupService.disable()
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
    if (seconds < 60) return "<1m"
    return Math.ceil(seconds / 60) + "m"
  }

  Process {
    id: workspaceOpener
    command: ["xdg-open", root.pendingWorkspacePath]
    onExited: function(exitCode) {
      if (exitCode !== 0) root.revealError = "Could not open the workspace directory"
    }
  }

  Connections {
    target: root.backupService
    ignoreUnknownSignals: true
    function onDirectoryChanged() {
      if (!manualPath.activeFocus) {
        root.manualBackupDirectory = root.backupService.directory
      }
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
          maximumLineCount: 3
          elide: Text.ElideRight
          text: root.service.errorMessage
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          visible: root.revealError !== ""
          width: parent.width
          wrapMode: Text.Wrap
          maximumLineCount: 3
          elide: Text.ElideRight
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
                + " · " + modelData.agentId + " · " + root.leaseRemaining(modelData.expiresAt)
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

            Rectangle {
              anchors.fill: parent
              radius: Style.space(4)
              color: root.foreground
              opacity: projectAction.activeFocus ? 0.13
                : projectAction.containsMouse ? 0.07 : 0
              border.width: projectAction.activeFocus ? 1 : 0
              border.color: root.foreground
            }

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

            PimpampumActionArea {
              id: projectAction
              anchors.fill: parent
              triggerOnClick: false
              Accessible.name: "Open " + modelData.title + " in " + modelData.workspace.name
              onTriggered: root.openWorkspace(modelData.workspace.rootPath)
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

          Rectangle {
            anchors.fill: parent
            radius: Style.space(4)
            color: root.foreground
            opacity: completedAction.activeFocus ? 0.13
              : completedAction.containsMouse ? 0.07 : 0
            border.width: completedAction.activeFocus ? 1 : 0
            border.color: root.foreground
          }

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

          PimpampumActionArea {
            id: completedAction
            anchors.fill: parent
            focusOnTab: parent.visible
            Accessible.name: completedTitle.text
            Accessible.description: root.completedExpanded ? "Expanded" : "Collapsed"
            onTriggered: root.toggleCompleted()
          }
        }

        Repeater {
          model: root.completedExpanded ? root.completedProjects : []

          delegate: Item {
            required property var modelData
            width: content.width
            height: completedText.implicitHeight + Style.space(10)

            Rectangle {
              anchors.fill: parent
              radius: Style.space(4)
              color: root.foreground
              opacity: completedRowAction.activeFocus ? 0.13
                : completedRowAction.containsMouse ? 0.07 : 0
              border.width: completedRowAction.activeFocus ? 1 : 0
              border.color: root.foreground
            }

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

            PimpampumActionArea {
              id: completedRowAction
              anchors.fill: parent
              Accessible.name: "Open " + modelData.title + " in " + modelData.workspace.name
              onTriggered: root.openWorkspace(modelData.workspace.rootPath)
            }
          }
        }

        Item {
          visible: root.cancelledProjects.length > 0
          width: parent.width
          height: cancelledTitle.implicitHeight + Style.space(8)

          Rectangle {
            anchors.fill: parent
            radius: Style.space(4)
            color: root.foreground
            opacity: cancelledAction.activeFocus ? 0.13
              : cancelledAction.containsMouse ? 0.07 : 0
            border.width: cancelledAction.activeFocus ? 1 : 0
            border.color: root.foreground
          }

          Text {
            id: cancelledTitle
            anchors.verticalCenter: parent.verticalCenter
            text: (root.cancelledExpanded ? "▾ " : "▸ ")
              + "Cancelled (" + root.cancelledProjects.length + ")"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
          }

          PimpampumActionArea {
            id: cancelledAction
            anchors.fill: parent
            focusOnTab: parent.visible
            Accessible.name: cancelledTitle.text
            Accessible.description: root.cancelledExpanded ? "Expanded" : "Collapsed"
            onTriggered: root.toggleCancelled()
          }
        }

        Repeater {
          model: root.cancelledExpanded ? root.cancelledProjects : []

          delegate: Item {
            required property var modelData
            width: content.width
            height: cancelledText.implicitHeight + Style.space(10)

            Rectangle {
              anchors.fill: parent
              radius: Style.space(4)
              color: root.foreground
              opacity: cancelledRowAction.activeFocus ? 0.13
                : cancelledRowAction.containsMouse ? 0.07 : 0
              border.width: cancelledRowAction.activeFocus ? 1 : 0
              border.color: root.foreground
            }

            Text {
              id: cancelledText
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width
              elide: Text.ElideRight
              text: modelData.title + " · Cancelled · "
                + modelData.workspace.name + " / " + modelData.slug
              color: root.foreground
              opacity: 0.72
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            PimpampumActionArea {
              id: cancelledRowAction
              anchors.fill: parent
              Accessible.name: "Open cancelled project " + modelData.title
                + " in " + modelData.workspace.name
              onTriggered: root.openWorkspace(modelData.workspace.rootPath)
            }
          }
        }

        Item {
          width: parent.width
          height: backupTitle.implicitHeight + Style.space(8)

          Rectangle {
            anchors.fill: parent
            radius: Style.space(4)
            color: root.foreground
            opacity: backupAction.activeFocus ? 0.13
              : backupAction.containsMouse ? 0.07 : 0
            border.width: backupAction.activeFocus ? 1 : 0
            border.color: root.foreground
          }

          Text {
            id: backupTitle
            anchors.verticalCenter: parent.verticalCenter
            text: (root.backupExpanded ? "▾ " : "▸ ") + "Backup"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
          }

          PimpampumActionArea {
            id: backupAction
            anchors.fill: parent
            Accessible.name: backupTitle.text
            Accessible.description: root.backupExpanded ? "Expanded" : "Collapsed"
            onTriggered: root.toggleBackup()
          }
        }

        Column {
          visible: root.backupExpanded
          width: parent.width
          spacing: Style.space(7)

          Text {
            visible: root.backupService.enabled
            width: parent.width
            elide: Text.ElideMiddle
            text: root.backupService.directory
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: root.backupStatusText()
            color: root.backupService.backupState === "error" ? root.urgent
              : root.backupService.backupState === "healthy" ? "#22c55e"
              : root.foreground
            opacity: root.backupService.backupState === "disabled" ? 0.72 : 1
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            visible: root.backupService.statusError !== ""
              || root.backupService.operationError !== ""
            width: parent.width
            wrapMode: Text.Wrap
            text: root.backupService.operationError !== ""
              ? root.backupService.operationError : root.backupService.statusError
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            text: "Backup folder (absolute path)"
            color: root.foreground
            opacity: 0.72
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Rectangle {
            width: parent.width
            height: Style.space(30)
            radius: Style.space(4)
            color: "transparent"
            border.width: manualPath.activeFocus ? 2 : 1
            border.color: root.foreground
            opacity: root.backupService.busy ? 0.55 : 0.85

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              visible: manualPath.text === "" && !manualPath.activeFocus
              text: "/home/you/Dropbox/Pimpampum"
              color: root.foreground
              opacity: 0.45
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            TextInput {
              id: manualPath
              anchors.fill: parent
              anchors.leftMargin: Style.space(8)
              anchors.rightMargin: Style.space(8)
              verticalAlignment: TextInput.AlignVCenter
              clip: true
              selectByMouse: true
              enabled: !root.backupService.busy
              text: root.manualBackupDirectory
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              onTextEdited: root.manualBackupDirectory = text
              onAccepted: {
                if (root.backupService.isAbsolutePath(text)) {
                  root.backupService.configure(text)
                }
              }
            }
          }

          Flow {
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              model: [
                { label: "Choose…", action: "choose", enabled: root.folderDialogAvailable },
                {
                  label: "Save",
                  action: "save",
                  enabled: root.backupService.isAbsolutePath(root.manualBackupDirectory)
                },
                { label: "Open", action: "open", enabled: root.backupService.enabled },
                { label: "Back Up Now", action: "retry", enabled: root.backupService.enabled },
                { label: "Disable", action: "disable", enabled: root.backupService.enabled }
              ]

              delegate: Rectangle {
                required property var modelData
                visible: modelData.action !== "choose" || root.folderDialogAvailable
                width: actionLabel.implicitWidth + Style.space(16)
                height: Style.space(28)
                radius: Style.space(4)
                color: modelData.action === "disable" ? root.urgent : root.foreground
                opacity: modelData.enabled && !root.backupService.busy
                  ? actionArea.activeFocus ? 0.22 : actionArea.containsMouse ? 0.17 : 0.11
                  : 0.05
                border.width: actionArea.activeFocus ? 1 : 0
                border.color: modelData.action === "disable" ? root.urgent : root.foreground

                Text {
                  id: actionLabel
                  anchors.centerIn: parent
                  text: modelData.label
                  color: modelData.action === "disable" ? root.urgent : root.foreground
                  opacity: modelData.enabled && !root.backupService.busy ? 1 : 0.45
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                PimpampumActionArea {
                  id: actionArea
                  anchors.fill: parent
                  enabled: modelData.enabled && !root.backupService.busy
                  focusOnTab: enabled && root.backupExpanded && parent.visible
                  Accessible.name: modelData.label
                  onTriggered: root.runBackupAction(modelData.action)
                }
              }
            }
          }

          Text {
            visible: !root.folderDialogAvailable
            width: parent.width
            wrapMode: Text.Wrap
            text: "Folder picker unavailable; enter an absolute path above."
            color: root.foreground
            opacity: 0.58
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
