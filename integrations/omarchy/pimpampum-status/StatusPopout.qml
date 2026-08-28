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
  required property var syncService
  required property var serviceControl
  property bool opened: false
  property bool settingsView: false
  property bool helpView: false
  property bool completedExpanded: false
  property bool cancelledExpanded: false
  property string manualBackupDirectory: ""
  property string manualSyncDirectory: ""
  property bool confirmingSyncForget: false
  property bool confirmingBackupDisable: false
  property bool confirmingSyncEnable: false
  property bool confirmingBackupEnable: false
  property bool syncManageOpen: false
  property bool backupManageOpen: false
  property bool confirmingServiceStop: false
  property string pendingFolderTarget: ""
  property string folderPickerOutput: ""
  property string revealError: ""
  property string pendingWorkspacePath: ""
  readonly property string pickerHelperPath: decodeURIComponent(
    Qt.resolvedUrl("pimpampum-folder-picker").toString().replace(/^file:\/\//, "")
  )
  readonly property bool folderDialogOpen: folderPicker.running
  readonly property bool folderDialogAvailable: pickerHelperPath.charAt(0) === "/"

  readonly property color foreground: bar ? bar.barForeground : "white"
  readonly property color background: bar ? bar.background : "#202020"
  readonly property color urgent: bar ? bar.urgent : "#ff5f57"
  readonly property color accent: Color.accent
  readonly property string fontFamily: bar ? bar.fontFamily : "monospace"
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

  function open() {
    if (opened) return
    opened = true
    service.refresh()
    backupService.refresh()
    syncService.refresh()
  }

  function chooseDirectory(target) {
    if (folderPicker.running || !folderDialogAvailable) return
    pendingFolderTarget = target
    folderPickerOutput = ""
    folderPicker.command = [pickerHelperPath,
      target === "backup" ? "Choose a backup destination" : "Choose a provider-synced location"]
    folderPicker.running = true
  }

  function acceptFolderPicker(exitCode) {
    if (exitCode === 1) return
    var path = folderPickerOutput.trim()
    if (exitCode !== 0 || !backupService.isAbsolutePath(path)) {
      if (pendingFolderTarget === "backup") backupService.operationError = "Folder picker unavailable; configure backup from the Pimpampum CLI"
      else syncService.operationError = "Folder picker unavailable; configure synchronization from the Pimpampum CLI"
      return
    }
    if (pendingFolderTarget === "backup") {
      manualBackupDirectory = path
      confirmingBackupEnable = true
    } else {
      manualSyncDirectory = path
      confirmingSyncEnable = true
    }
  }

  function syncStatusText() {
    if (syncService.busy) return ({
      "configure": "Enabling synchronization…", "now": "Synchronizing…",
      "pause": "Pausing synchronization…", "resume": "Resuming synchronization…",
      "forget": "Forgetting shared folder…", "status": "Checking synchronization…"
    })[syncService.pendingOperation] || "Updating synchronization…"
    return ({
      "disabled": "Not configured", "paused": "Synchronization paused",
      "pending": "Changes pending", "importing": "Importing changes…",
      "exporting": "Exporting changes…", "healthy": "Up to date",
      "unavailable": "Shared folder unavailable; local changes are safe",
      "error": "Synchronization needs attention", "conflict": "Conflict requires attention"
    })[syncService.syncState] || "Synchronization unavailable"
  }

  function effectiveSyncDirectory(path) {
    if (!syncService.isAbsolutePath(path)) return ""
    var trimmed = path.replace(/\/+$/, "")
    var parts = trimmed.split("/")
    return parts[parts.length - 1].toLowerCase() === "pimpampum"
      ? trimmed : trimmed + "/Pimpampum"
  }

  function formatSyncTime(value) {
    return value === "" ? "Never" : new Date(value).toLocaleString()
  }

  function formatLastSync() {
    var imported = Date.parse(syncService.lastImportAt)
    var exported = Date.parse(syncService.lastExportAt)
    if (isNaN(imported) && isNaN(exported)) return "Never"
    return formatSyncTime(imported > exported ? syncService.lastImportAt : syncService.lastExportAt)
  }

  function runSyncAction(action) {
    if (action === "choose") chooseDirectory("sync")
    else if (action === "confirm-enable") { confirmingSyncEnable = false; syncService.configure(manualSyncDirectory) }
    else if (action === "cancel-enable") { confirmingSyncEnable = false; if (!syncService.enabled) manualSyncDirectory = "" }
    else if (action === "now") syncService.syncNow()
    else if (action === "open") syncService.openDirectory()
    else if (action === "toggle") syncService.setPaused(!syncService.paused)
    else if (action === "forget") confirmingSyncForget = true
    else if (action === "confirm-forget") {
      confirmingSyncForget = false
      syncService.forget()
    } else if (action === "cancel-forget") confirmingSyncForget = false
  }

  function backupStatusText() {
    if (backupService.busy) return ({
      "configure": "Enabling automatic backup…", "retry": "Creating backup…",
      "disable": "Disabling automatic backup…", "status": "Checking backup…"
    })[backupService.pendingOperation] || "Updating backup…"
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

  function runBackupAction(action) {
    if (action === "choose") chooseDirectory("backup")
    else if (action === "confirm-enable") { confirmingBackupEnable = false; backupService.configure(manualBackupDirectory) }
    else if (action === "cancel-enable") { confirmingBackupEnable = false; if (!backupService.enabled) manualBackupDirectory = "" }
    else if (action === "open") backupService.openDirectory()
    else if (action === "retry") backupService.retry()
    else if (action === "disable") confirmingBackupDisable = true
    else if (action === "confirm-disable") { confirmingBackupDisable = false; backupService.disable() }
    else if (action === "cancel-disable") confirmingBackupDisable = false
  }

  function runServiceAction(action) {
    if (action === "stop") confirmingServiceStop = true
    else if (action === "cancel-stop") confirmingServiceStop = false
    else if (action === "confirm-stop") {
      confirmingServiceStop = false
      serviceControl.stop()
    } else if (action === "start") serviceControl.start()
    else if (action === "restart") serviceControl.restart()
  }

  function close() {
    if (!opened) return
    showSettings(false)
    opened = false
  }

  function showSettings(value) {
    settingsView = value
    helpView = false
    confirmingSyncEnable = false
    confirmingBackupEnable = false
    confirmingSyncForget = false
    confirmingBackupDisable = false
    syncManageOpen = false
    backupManageOpen = false
    confirmingServiceStop = false
    scroller.contentY = 0
    if (value) {
      manualSyncDirectory = syncService.directory
      manualBackupDirectory = backupService.directory
      syncService.refresh()
      backupService.refresh()
    }
  }

  function showHelp(value) {
    helpView = value
    scroller.contentY = 0
  }

  function openHelp() {
    showSettings(true)
    showHelp(true)
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
    // Repeated activation while the launcher is busy is not a user-facing error.
    if (workspaceOpener.running) return
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
    id: folderPicker
    command: [root.pickerHelperPath, "Choose a folder"]
    stdout: StdioCollector { onStreamFinished: root.folderPickerOutput = text }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.acceptFolderPicker(exitCode) })
    }
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
    // A native folder dialog must be allowed to take focus without dismissing us.
    triggerMode: root.folderDialogOpen ? "hover" : "click"
    // PopupCard maps this state to bar.requestPopout(owner) and
    // bar.releasePopout(owner), avoiding competing popup windows.
    open: root.opened
    contentWidth: fittedContentWidth(Style.space(380))
    contentHeight: fittedContentHeight(Math.min(content.implicitHeight + Style.space(55), Style.space(520)))

    Flickable {
      id: scroller
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.bottom: footerSeparator.top
      contentWidth: width
      contentHeight: content.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      Column {
        id: content
        width: parent.width
        spacing: Style.space(10)

        Item {
          width: parent.width
          height: Math.max(headerMark.implicitHeight, headerAction.height)

          PimpampumMark {
            id: headerMark
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            status: root.service.effectiveStatus
            statusLabel: root.service.stale ? "Stale" : root.service.connectionState
            stale: root.service.stale
            vertical: false
            activeClaims: root.service.activeClaims
            showActiveCount: false
            foreground: root.foreground
            contrastBackground: root.background
            urgent: root.urgent
            activeColor: "#3b82f6"
            availableColor: "#f59e0b"
            completeColor: "#22c55e"
            fontFamily: root.fontFamily
          }

          Column {
            id: headerCopy
            anchors.left: headerMark.right
            anchors.leftMargin: Style.space(10)
            anchors.right: headerAction.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(1)

            Text {
              text: root.helpView ? "Help" : root.settingsView ? "Settings" : "Pimpampum"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }

            Text {
              text: root.helpView ? "Portfolio, synchronization, and backup"
                : root.settingsView ? "Synchronization and backup"
                : root.service.stale ? "Stale" : root.service.connectionState
              color: root.service.connectionState === "online" ? root.foreground : root.urgent
              opacity: root.service.connectionState === "online" ? 0.72 : 1
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Item {
            id: headerAction
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(44)
            height: Style.space(44)

            Rectangle {
              anchors.fill: parent
              radius: Style.space(4)
              color: root.foreground
              opacity: headerActionArea.activeFocus ? 0.13
                : headerActionArea.containsMouse ? 0.07 : 0
              border.width: headerActionArea.activeFocus ? 1 : 0
              border.color: root.foreground
            }
            PimpampumHeaderIcon {
              anchors.centerIn: parent
              width: Style.space(24)
              height: Style.space(24)
              iconColor: root.foreground
              back: root.settingsView
            }
            PimpampumActionArea {
              id: headerActionArea
              anchors.fill: parent
              Accessible.name: root.helpView ? "Back to portfolio"
                : root.settingsView ? "Back to portfolio" : "Open settings"
              onTriggered: {
                if (root.helpView) root.showSettings(false)
                else root.showSettings(!root.settingsView)
              }
            }
          }
        }

        Rectangle {
          width: parent.width
          height: 1
          color: root.foreground
          opacity: 0.14
        }

        Text {
          visible: !root.settingsView && root.service.connectionState !== "online"
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
          visible: !root.settingsView && root.revealError !== ""
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
          visible: !root.settingsView && root.service.overview && root.service.overview.counts.projects === 0
          text: root.service.overview && root.service.overview.counts.workspaces === 0
            ? "No workspaces. Run: pimpampum workspace:add"
            : "No projects"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }

        Text {
          visible: !root.settingsView && root.activeWork.length > 0
          text: "Active work (" + root.activeWork.length + ")"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Repeater {
          model: root.settingsView ? [] : root.activeWork

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
          visible: !root.settingsView && root.service.overview && root.service.overview.activeWorkTruncated
          text: "Active work list truncated"
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          visible: !root.settingsView && root.inProgressSpecs.length > 0
          text: "Specs in progress (" + root.inProgressSpecs.length + ")"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Repeater {
          model: root.settingsView ? [] : root.inProgressSpecs

          delegate: Item {
            required property var modelData
            width: content.width
            height: inProgressSpecText.implicitHeight + Style.space(10)

            Rectangle {
              anchors.fill: parent
              radius: Style.space(4)
              color: root.foreground
              opacity: inProgressSpecAction.activeFocus ? 0.13
                : inProgressSpecAction.containsMouse ? 0.07 : 0
              border.width: inProgressSpecAction.activeFocus ? 1 : 0
              border.color: root.foreground
            }

            Column {
              id: inProgressSpecText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(1)

              Text {
                width: parent.width
                elide: Text.ElideRight
                text: modelData.title
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                width: parent.width
                elide: Text.ElideRight
                text: modelData.projectTitle + " · " + modelData.completedTaskCount
                  + "/" + modelData.taskCount + " tasks"
                  + (modelData.activeClaimCount > 0 ? " · active" : "")
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            PimpampumActionArea {
              id: inProgressSpecAction
              anchors.fill: parent
              Accessible.name: "Open " + modelData.title + " from " + modelData.projectTitle
              onTriggered: root.openWorkspace(modelData.workspace.rootPath)
            }
          }
        }

        Text {
          visible: !root.settingsView && root.service.overview && root.service.overview.specsTruncated
          text: "Spec list truncated"
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          visible: !root.settingsView && root.incompleteProjects.length > 0
          text: "Projects (" + root.incompleteProjects.length + ")"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Repeater {
          model: root.settingsView ? [] : root.incompleteProjects

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
          visible: !root.settingsView && root.service.overview && root.service.overview.projectsTruncated
          text: "Project list truncated"
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Item {
          visible: !root.settingsView && root.completedSpecs.length > 0
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
              + "Completed specs (" + root.completedSpecs.length + ")"
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
          model: !root.settingsView && root.completedExpanded ? root.completedSpecs : []

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
              text: modelData.title + " · " + modelData.projectTitle
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            PimpampumActionArea {
              id: completedRowAction
              anchors.fill: parent
              Accessible.name: "Open " + modelData.title + " from " + modelData.projectTitle
              onTriggered: root.openWorkspace(modelData.workspace.rootPath)
            }
          }
        }

        Item {
          visible: !root.settingsView && root.cancelledProjects.length > 0
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
          model: !root.settingsView && root.cancelledExpanded ? root.cancelledProjects : []

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

        Column {
          id: settingsSummary
          visible: root.settingsView && !root.helpView
          width: parent.width
          spacing: Style.space(10)

          Rectangle {
            width: parent.width
            height: syncCardContent.implicitHeight + Style.space(28)
            radius: Style.space(6)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

            Column {
              id: syncCardContent
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(14)
              spacing: Style.space(8)

              Row {
                width: parent.width
                spacing: Style.space(8)
                Text {
                  width: parent.width - syncStateLabel.width - parent.spacing
                  text: "Synchronization"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                }
                Text {
                  id: syncStateLabel
                  text: "● " + root.syncStatusText()
                  color: root.syncService.syncState === "conflict"
                    || root.syncService.syncState === "error" ? root.urgent
                    : root.syncService.syncState === "healthy" ? "#22c55e" : root.foreground
                  opacity: root.syncService.syncState === "disabled" ? 0.58 : 1
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: root.syncService.enabled
                  ? "Keeps changes available on your other computers."
                  : "Share changes across computers using a provider-synced folder."
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Row {
                visible: root.syncService.enabled && !root.confirmingSyncForget
                  && !root.confirmingSyncEnable
                width: parent.width
                spacing: Style.space(6)
                Text {
                  width: Math.max(0, parent.width - syncOpenButton.width
                    - syncManageButton.width - parent.spacing * 2)
                  anchors.verticalCenter: parent.verticalCenter
                  elide: Text.ElideMiddle
                  text: root.syncService.directory
                  color: root.foreground
                  opacity: 0.72
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
                PimpampumSettingsButton {
                  id: syncOpenButton
                  width: implicitWidth
                  height: implicitHeight
                  label: "Open"
                  compact: true
                  minimumWidth: Style.space(48)
                  foreground: root.foreground
                  background: root.background
                  accent: root.accent
                  urgent: root.urgent
                  fontFamily: root.fontFamily
                  actionEnabled: !root.syncService.busy
                  onTriggered: root.runSyncAction("open")
                }
                PimpampumSettingsButton {
                  id: syncManageButton
                  width: implicitWidth
                  height: implicitHeight
                  label: root.syncManageOpen ? "Close" : "Manage"
                  compact: true
                  minimumWidth: Style.space(64)
                  foreground: root.foreground
                  background: root.background
                  accent: root.accent
                  urgent: root.urgent
                  fontFamily: root.fontFamily
                  onTriggered: root.syncManageOpen = !root.syncManageOpen
                }
              }

              Rectangle {
                visible: root.syncManageOpen && root.syncService.enabled
                  && !root.confirmingSyncForget && !root.confirmingSyncEnable
                width: parent.width
                height: syncManageActions.implicitHeight + Style.space(16)
                radius: Style.space(4)
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
                border.width: 1
                border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.1)
                Row {
                  id: syncManageActions
                  anchors.centerIn: parent
                  spacing: Style.space(6)
                  PimpampumSettingsButton {
                    width: implicitWidth; height: implicitHeight
                    label: "Change location"
                    foreground: root.foreground; background: root.background
                    accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                    actionEnabled: root.folderDialogAvailable && !root.syncService.busy
                    onTriggered: { root.syncManageOpen = false; root.runSyncAction("choose") }
                  }
                  PimpampumSettingsButton {
                    width: implicitWidth; height: implicitHeight
                    label: "Forget…"
                    destructive: true
                    foreground: root.foreground; background: root.background
                    accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                    actionEnabled: !root.syncService.busy
                    onTriggered: { root.syncManageOpen = false; root.runSyncAction("forget") }
                  }
                }
              }

              Grid {
                visible: root.syncService.enabled && !root.confirmingSyncForget
                  && !root.confirmingSyncEnable
                width: parent.width
                columns: 2
                columnSpacing: Style.space(12)
                rowSpacing: Style.space(4)
                Text { text: "This device"; color: root.foreground; opacity: 0.55; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                Text { width: syncCardContent.width - Style.space(92); horizontalAlignment: Text.AlignRight; elide: Text.ElideRight; text: root.syncService.deviceId; color: root.foreground; opacity: 0.72; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                Text { text: "Pending"; color: root.foreground; opacity: 0.55; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                Text { width: syncCardContent.width - Style.space(92); horizontalAlignment: Text.AlignRight; text: root.syncService.pendingCount + " snapshots"; color: root.foreground; opacity: 0.72; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                Text { text: "Last sync"; color: root.foreground; opacity: 0.55; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                Text { width: syncCardContent.width - Style.space(92); horizontalAlignment: Text.AlignRight; elide: Text.ElideLeft; text: root.formatLastSync(); color: root.foreground; opacity: 0.72; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
              }

              Text {
                visible: root.syncService.conflictCount > 0
                width: parent.width
                wrapMode: Text.Wrap
                text: root.syncService.conflictCount + " conflict(s) need attention. Run ‘pimpampum sync conflicts’ to review them."
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                visible: root.syncService.statusError !== "" || root.syncService.operationError !== ""
                width: parent.width
                wrapMode: Text.Wrap
                text: root.syncService.operationError !== "" ? root.syncService.operationError : root.syncService.statusError
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                visible: root.confirmingSyncEnable
                width: parent.width
                wrapMode: Text.Wrap
                text: "Use “" + root.effectiveSyncDirectory(root.manualSyncDirectory)
                  + "”? Existing snapshots may be imported before this computer publishes its portfolio."
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                visible: root.confirmingSyncForget
                width: parent.width
                wrapMode: Text.Wrap
                text: "Stop using this shared folder? Shared snapshots and local portfolio data will not be deleted."
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Row {
                width: parent.width
                spacing: Style.space(6)
                PimpampumSettingsButton {
                  id: syncSecondaryAction
                  visible: root.syncService.enabled || root.confirmingSyncEnable
                    || root.confirmingSyncForget
                  width: visible ? implicitWidth : 0
                  height: implicitHeight
                  label: root.confirmingSyncEnable || root.confirmingSyncForget ? "Cancel"
                    : root.syncService.paused ? "Resume" : "Pause"
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: !root.syncService.busy
                  onTriggered: root.runSyncAction(root.confirmingSyncEnable ? "cancel-enable"
                    : root.confirmingSyncForget ? "cancel-forget" : "toggle")
                }
                PimpampumSettingsButton {
                  id: syncPrimaryAction
                  width: Math.max(implicitWidth, parent.width - syncSecondaryAction.width
                    - (syncSecondaryAction.visible ? parent.spacing : 0))
                  height: implicitHeight
                  primary: !root.confirmingSyncForget
                  destructive: root.confirmingSyncForget
                  label: root.confirmingSyncEnable ? "Enable sync"
                    : root.confirmingSyncForget ? "Confirm forget"
                    : root.syncService.busy ? root.syncStatusText()
                    : root.syncService.enabled ? "Sync now" : "Set up sync"
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: !root.syncService.busy && !root.syncService.paused
                    && (root.syncService.enabled || root.folderDialogAvailable)
                  onTriggered: root.runSyncAction(root.confirmingSyncEnable ? "confirm-enable"
                    : root.confirmingSyncForget ? "confirm-forget"
                    : root.syncService.enabled ? "now" : "choose")
                }
              }
            }
          }

          Rectangle {
            width: parent.width
            height: backupCardContent.implicitHeight + Style.space(28)
            radius: Style.space(6)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

            Column {
              id: backupCardContent
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(14)
              spacing: Style.space(8)

              Row {
                width: parent.width
                spacing: Style.space(8)
                Text {
                  width: parent.width - backupStateLabel.width - parent.spacing
                  text: "Backup"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                }
                Text {
                  id: backupStateLabel
                  text: "● " + root.backupStatusText()
                  color: root.backupService.backupState === "error" ? root.urgent
                    : root.backupService.backupState === "healthy" ? "#22c55e" : root.foreground
                  opacity: root.backupService.backupState === "disabled" ? 0.58 : 1
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "Creates a recovery copy after every local change."
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Row {
                visible: root.backupService.enabled && !root.confirmingBackupEnable
                  && !root.confirmingBackupDisable
                width: parent.width
                spacing: Style.space(6)
                Text {
                  width: Math.max(0, parent.width - backupOpenButton.width
                    - backupManageButton.width - parent.spacing * 2)
                  anchors.verticalCenter: parent.verticalCenter
                  elide: Text.ElideMiddle
                  text: root.backupService.directory
                  color: root.foreground
                  opacity: 0.72
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
                PimpampumSettingsButton {
                  id: backupOpenButton
                  width: implicitWidth; height: implicitHeight; label: "Open"; compact: true
                  minimumWidth: Style.space(48)
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: !root.backupService.busy
                  onTriggered: root.runBackupAction("open")
                }
                PimpampumSettingsButton {
                  id: backupManageButton
                  width: implicitWidth; height: implicitHeight
                  label: root.backupManageOpen ? "Close" : "Manage"; compact: true
                  minimumWidth: Style.space(64)
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  onTriggered: root.backupManageOpen = !root.backupManageOpen
                }
              }
              Text {
                visible: !root.backupService.enabled && !root.confirmingBackupEnable
                width: parent.width
                text: "No destination chosen"
                color: root.foreground
                opacity: 0.55
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Rectangle {
                visible: root.backupManageOpen && root.backupService.enabled
                  && !root.confirmingBackupEnable && !root.confirmingBackupDisable
                width: parent.width
                height: backupManageActions.implicitHeight + Style.space(16)
                radius: Style.space(4)
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
                border.width: 1
                border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.1)
                Row {
                  id: backupManageActions
                  anchors.centerIn: parent
                  spacing: Style.space(6)
                  PimpampumSettingsButton {
                    width: implicitWidth; height: implicitHeight; label: "Change destination"
                    foreground: root.foreground; background: root.background
                    accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                    actionEnabled: root.folderDialogAvailable && !root.backupService.busy
                    onTriggered: { root.backupManageOpen = false; root.runBackupAction("choose") }
                  }
                  PimpampumSettingsButton {
                    width: implicitWidth; height: implicitHeight; label: "Disable…"
                    destructive: true
                    foreground: root.foreground; background: root.background
                    accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                    actionEnabled: !root.backupService.busy
                    onTriggered: { root.backupManageOpen = false; root.runBackupAction("disable") }
                  }
                }
              }
              Text {
                visible: root.backupService.statusError !== "" || root.backupService.operationError !== ""
                width: parent.width
                wrapMode: Text.Wrap
                text: root.backupService.operationError !== "" ? root.backupService.operationError : root.backupService.statusError
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                visible: root.confirmingBackupEnable
                width: parent.width
                wrapMode: Text.Wrap
                text: "Keep the latest recovery copy at “"
                  + root.manualBackupDirectory.replace(/\/+$/, "") + "/pimpampum-latest.sqlite”?"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                visible: root.confirmingBackupDisable
                width: parent.width
                wrapMode: Text.Wrap
                text: "Stop automatic backups? The existing backup file will not be deleted."
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Row {
                width: parent.width
                spacing: Style.space(6)
                PimpampumSettingsButton {
                  id: backupSecondaryAction
                  visible: root.confirmingBackupEnable || root.confirmingBackupDisable
                  width: visible ? implicitWidth : 0
                  height: implicitHeight
                  label: "Cancel"
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: !root.backupService.busy
                  onTriggered: root.runBackupAction(root.confirmingBackupEnable
                    ? "cancel-enable" : "cancel-disable")
                }
                PimpampumSettingsButton {
                  id: backupPrimaryAction
                  width: Math.max(implicitWidth, parent.width - backupSecondaryAction.width
                    - (backupSecondaryAction.visible ? parent.spacing : 0))
                  height: implicitHeight
                  primary: !root.confirmingBackupDisable
                  destructive: root.confirmingBackupDisable
                  label: root.confirmingBackupEnable ? "Enable backup"
                    : root.confirmingBackupDisable ? "Confirm disable"
                    : root.backupService.enabled ? "Back up now" : "Set up backup"
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: !root.backupService.busy
                    && (root.backupService.enabled || root.folderDialogAvailable)
                  onTriggered: root.runBackupAction(root.confirmingBackupEnable ? "confirm-enable"
                    : root.confirmingBackupDisable ? "confirm-disable"
                    : root.backupService.enabled ? "retry" : "choose")
                }
              }
            }
          }

          Rectangle {
            width: parent.width
            height: serviceCardContent.implicitHeight + Style.space(28)
            radius: Style.space(6)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

            Column {
              id: serviceCardContent
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(14)
              spacing: Style.space(8)

              Row {
                width: parent.width
                Text {
                  width: parent.width - serviceState.width
                  text: "Pimpampum service"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                }
                Text {
                  id: serviceState
                  text: root.serviceControl.busy ? "Updating…"
                    : root.serviceControl.running ? "Running" : "Stopped"
                  color: root.serviceControl.running ? "#22c55e" : root.foreground
                  opacity: root.serviceControl.running ? 1 : 0.62
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: root.serviceControl.running
                  ? "Keeps agents, synchronization, and automatic backups available in the background."
                  : "Agents and automatic background tasks are unavailable. Your local data is safe."
                color: root.foreground
                opacity: 0.68
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Text {
                visible: root.confirmingServiceStop
                width: parent.width
                wrapMode: Text.Wrap
                text: "Stop Pimpampum? Agents, synchronization, and automatic backups will stop working."
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Text {
                visible: root.serviceControl.operationError !== ""
                width: parent.width
                wrapMode: Text.Wrap
                text: root.serviceControl.operationError
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Row {
                width: parent.width
                spacing: Style.space(6)
                PimpampumSettingsButton {
                  id: serviceSecondaryAction
                  visible: root.serviceControl.running || root.confirmingServiceStop
                  width: visible ? Math.max(implicitWidth, parent.width / 2 - parent.spacing / 2) : 0
                  height: implicitHeight
                  label: root.confirmingServiceStop ? "Cancel" : "Restart service"
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: !root.serviceControl.busy
                  onTriggered: root.runServiceAction(root.confirmingServiceStop
                    ? "cancel-stop" : "restart")
                }
                PimpampumSettingsButton {
                  id: servicePrimaryAction
                  width: Math.max(implicitWidth, parent.width - serviceSecondaryAction.width
                    - (serviceSecondaryAction.visible ? parent.spacing : 0))
                  height: implicitHeight
                  primary: !root.serviceControl.running
                  destructive: root.serviceControl.running
                  label: root.confirmingServiceStop ? "Stop Pimpampum"
                    : root.serviceControl.running ? "Stop Pimpampum…" : "Start Pimpampum"
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: !root.serviceControl.busy
                  onTriggered: root.runServiceAction(root.confirmingServiceStop
                    ? "confirm-stop" : root.serviceControl.running ? "stop" : "start")
                }
              }
            }
          }

          Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: "Synchronization shares work between computers. Backup keeps a separate recovery copy."
            color: root.foreground
            opacity: 0.52
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            visible: !root.folderDialogAvailable && !root.syncService.enabled
            width: parent.width
            wrapMode: Text.Wrap
            text: "Folder picker unavailable. Configure synchronization from the Pimpampum CLI."
            color: root.foreground
            opacity: 0.58
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            visible: !root.folderDialogAvailable && !root.backupService.enabled
            width: parent.width
            wrapMode: Text.Wrap
            text: "Folder picker unavailable. Configure backup from the Pimpampum CLI."
            color: root.foreground
            opacity: 0.58
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        Column {
          id: helpPage
          visible: root.settingsView && root.helpView
          width: parent.width
          spacing: Style.space(10)

          Rectangle {
            width: parent.width
            height: helpProduct.implicitHeight + Style.space(28)
            radius: Style.space(6)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
            Column {
              id: helpProduct
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(14)
              spacing: Style.space(6)
              Text {
                text: "How Pimpampum works"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "Pimpampum is a local, agent-first project manager. Active work names the task being claimed now, followed by its project, Spec, agent, and remaining lease. Specs in progress remain visible even when no task is claimed and show completed versus total tasks. Completed Specs stay collapsed until you need the history. Project rows use the registered project and workspace names and open that workspace when selected."
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          Rectangle {
            width: parent.width
            height: helpIntro.implicitHeight + Style.space(28)
            radius: Style.space(6)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
            Column {
              id: helpIntro
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(14)
              spacing: Style.space(6)
              Text {
                text: "What is the difference?"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "Synchronization exchanges portfolio changes between your computers. Backup keeps a separate recovery copy of this computer’s local database."
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          Rectangle {
            width: parent.width
            height: helpFolders.implicitHeight + Style.space(28)
            radius: Style.space(6)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
            Column {
              id: helpFolders
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(14)
              spacing: Style.space(6)
              Text {
                text: "Why choose a shared folder?"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "Choose a location already managed by Dropbox, Syncthing, Drive, or a similar provider. Pimpampum creates a Pimpampum folder there and exchanges snapshots through it; Pimpampum does not upload files itself."
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          Rectangle {
            width: parent.width
            height: helpSafety.implicitHeight + Style.space(28)
            radius: Style.space(6)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
            Column {
              id: helpSafety
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(14)
              spacing: Style.space(6)
              Text {
                text: "Safe controls"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "Pause stops synchronization temporarily. Forget disconnects this computer without deleting shared snapshots or local data. Disabling backup stops new copies without deleting the existing backup file."
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          Rectangle {
            width: parent.width
            height: helpRecovery.implicitHeight + Style.space(28)
            radius: Style.space(6)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
            Column {
              id: helpRecovery
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(14)
              spacing: Style.space(6)
              Text {
                text: "Conflicts and recovery"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "Inspect both candidates before resolving a conflict:"
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "pimpampum sync conflicts"
                color: root.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "The recovery file is named pimpampum-latest.sqlite in your chosen backup destination."
                color: root.foreground
                opacity: 0.72
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }

      }
    }

    Rectangle {
      id: footerSeparator
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: footer.top
      height: 1
      color: root.foreground
      opacity: 0.14
    }

    Item {
      id: footer
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      height: Style.space(44)

      Item {
        id: footerHelpAction
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: footerHelpLabel.implicitWidth + Style.space(20)
        height: Style.space(44)

        Rectangle {
          anchors.fill: parent
          radius: Style.space(4)
          color: root.foreground
          opacity: footerHelpActionArea.activeFocus ? 0.13
            : footerHelpActionArea.containsMouse ? 0.07 : 0
          border.width: footerHelpActionArea.activeFocus ? 1 : 0
          border.color: root.foreground
        }

        Text {
          id: footerHelpLabel
          anchors.centerIn: parent
          text: "Help"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PimpampumActionArea {
          id: footerHelpActionArea
          anchors.fill: parent
          focusOnTab: parent.visible
          Accessible.name: "Open help"
          onTriggered: root.openHelp()
        }
      }

      Item {
        id: quitAction
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        width: quitLabel.implicitWidth + Style.space(20)
        height: Style.space(44)

        Rectangle {
          anchors.fill: parent
          radius: Style.space(4)
          color: root.foreground
          opacity: quitActionArea.activeFocus ? 0.13
            : quitActionArea.containsMouse ? 0.07 : 0
          border.width: quitActionArea.activeFocus ? 1 : 0
          border.color: root.foreground
        }

        Text {
          id: quitLabel
          anchors.centerIn: parent
          text: root.serviceControl.running ? "Quit" : "Start"
          color: root.foreground
          opacity: root.serviceControl.busy ? 0.5 : 1
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PimpampumActionArea {
          id: quitActionArea
          anchors.fill: parent
          enabled: !root.serviceControl.busy
          focusOnTab: parent.visible && enabled
          Accessible.name: root.serviceControl.running ? "Quit Pimpampum" : "Start Pimpampum"
          onTriggered: {
            if (root.serviceControl.running) root.serviceControl.stop()
            else root.serviceControl.start()
          }
        }
      }
    }
  }
}
