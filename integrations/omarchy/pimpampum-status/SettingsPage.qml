import QtQuick
import qs.Commons

// The settings view: agents, updates, synchronization, backup and the background service, then
// the footnotes. Every flag and action belongs to `controller` (the PopoutController); the cards
// only render what it holds.
Column {
  id: root

  required property var controller
  required property var connectionService
  required property var backupService
  required property var syncService
  required property var serviceControl
  required property var updateService
  required property color foreground
  required property color background
  required property color accent
  required property color urgent
  required property string fontFamily

  spacing: Style.space(10)

  AgentsSettingsCard {
    width: parent.width
    guided: false
    service: root.connectionService
    foreground: root.foreground
    background: root.background
    accent: root.accent
    urgent: root.urgent
    fontFamily: root.fontFamily
  }

  PimpampumCard {
    width: parent.width
    foreground: root.foreground
    Text { text: "Updates"; color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body; font.bold: true }
    Text {
      width: parent.width; wrapMode: Text.Wrap; color: root.foreground; opacity: 0.72
      font.family: root.fontFamily; font.pixelSize: Style.font.caption
      text: root.updateService.state === "available" ? "Pimpampum " + root.updateService.latestVersion + " is available."
        : root.updateService.state === "current" ? "Pimpampum is up to date."
        : root.updateService.state === "installing" ? "Installing and restarting Pimpampum…"
        : root.updateService.errorMessage !== "" ? root.updateService.errorMessage
        : "Check for a newer Pimpampum release. Nothing changes until you install it."
    }
    // The Linux runtime is pinned by this plugin, so `update` is refused with a typed
    // remedy: the bootstrap helper next to this file. Shown as a command on its own
    // surface, like `pimpampum install` in the credentials state.
    Rectangle {
      visible: root.updateService.remedy !== ""
      width: parent.width
      height: updateRemedy.implicitHeight + Style.space(14)
      radius: Style.space(4)
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.07)
      border.width: 1
      border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
      Text {
        id: updateRemedy
        anchors.left: parent.left; anchors.leftMargin: Style.space(10)
        anchors.right: parent.right; anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        wrapMode: Text.WrapAnywhere
        text: controller.pluginDirectory + "/" + root.updateService.remedy
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }
    }
    PimpampumSettingsButton {
      width: parent.width; height: implicitHeight
      label: root.updateService.updateAvailable ? "Install update" : root.updateService.busy ? "Checking…" : "Check for updates"
      primary: root.updateService.updateAvailable
      foreground: root.foreground; background: root.background; accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
      actionEnabled: !root.updateService.busy
      onTriggered: root.updateService.run(root.updateService.updateAvailable ? "install" : "check")
    }
  }

  ManagedFolderCard {
    id: syncCard
    width: parent.width
    foreground: root.foreground; background: root.background
    accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
    title: "Synchronization"
    description: root.syncService.enabled
      ? "Keeps changes available on your other computers."
      : "Share changes across computers using a provider-synced folder."
    stateText: controller.syncStatusText()
    stateColor: root.syncService.syncState === "conflict"
      || root.syncService.syncState === "error" ? root.urgent
      : root.syncService.syncState === "healthy" ? "#22c55e" : root.foreground
    stateOpacity: root.syncService.syncState === "disabled" ? 0.58 : 1
    configured: root.syncService.enabled
    busy: root.syncService.busy
    directory: root.syncService.directory
    manageOpen: controller.syncManageOpen
    confirming: controller.confirmingSyncForget || controller.confirmingSyncEnable
    folderDialogAvailable: controller.folderDialogAvailable
    changeLabel: "Change location"
    removeLabel: "Forget…"
    errorText: root.syncService.operationError !== "" ? root.syncService.operationError : root.syncService.statusError
    confirmationText: controller.confirmingSyncEnable
      ? "Use “" + controller.effectiveSyncDirectory(controller.manualSyncDirectory)
        + "”? Existing snapshots may be imported before this computer publishes its portfolio."
      : controller.confirmingSyncForget
      ? "Stop using this shared folder? Shared snapshots and local portfolio data will not be deleted."
      : ""
    confirmationUrgent: controller.confirmingSyncForget
    secondaryVisible: root.syncService.enabled || controller.confirmingSyncEnable
      || controller.confirmingSyncForget
    secondaryLabel: controller.confirmingSyncEnable || controller.confirmingSyncForget ? "Cancel"
      : root.syncService.paused ? "Resume" : "Pause"
    primaryLabel: controller.confirmingSyncEnable ? "Enable sync"
      : controller.confirmingSyncForget ? "Confirm forget"
      : root.syncService.busy ? controller.syncStatusText()
      : root.syncService.enabled ? "Sync now" : "Set up sync"
    primaryDestructive: controller.confirmingSyncForget
    primaryEnabled: !root.syncService.busy && !root.syncService.paused
      && (root.syncService.enabled || controller.folderDialogAvailable)
    onOpenRequested: controller.runSyncAction("open")
    onManageToggled: controller.syncManageOpen = !controller.syncManageOpen
    onChangeRequested: { controller.syncManageOpen = false; controller.runSyncAction("choose") }
    onRemoveRequested: { controller.syncManageOpen = false; controller.runSyncAction("forget") }
    onSecondaryTriggered: controller.runSyncAction(controller.confirmingSyncEnable ? "cancel-enable"
      : controller.confirmingSyncForget ? "cancel-forget" : "toggle")
    onPrimaryTriggered: controller.runSyncAction(controller.confirmingSyncEnable ? "confirm-enable"
      : controller.confirmingSyncForget ? "confirm-forget"
      : root.syncService.enabled ? "now" : "choose")
    details: [
      Grid {
        visible: root.syncService.enabled && !controller.confirmingSyncForget
          && !controller.confirmingSyncEnable
        width: parent.width
        columns: 2
        columnSpacing: Style.space(12)
        rowSpacing: Style.space(4)
        Text { text: "This device"; color: root.foreground; opacity: 0.55; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
        Text { width: parent.width - Style.space(92); horizontalAlignment: Text.AlignRight; elide: Text.ElideRight; text: root.syncService.deviceId; color: root.foreground; opacity: 0.72; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
        Text { text: "Pending"; color: root.foreground; opacity: 0.55; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
        Text { width: parent.width - Style.space(92); horizontalAlignment: Text.AlignRight; text: root.syncService.pendingCount + " snapshots"; color: root.foreground; opacity: 0.72; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
        Text { text: "Last sync"; color: root.foreground; opacity: 0.55; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
        Text { width: parent.width - Style.space(92); horizontalAlignment: Text.AlignRight; elide: Text.ElideLeft; text: controller.formatLastSync(); color: root.foreground; opacity: 0.72; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
      },
      Text {
        visible: root.syncService.conflictCount > 0
        width: parent.width
        wrapMode: Text.Wrap
        text: root.syncService.conflictCount + " conflict(s) need attention. Run ‘pimpampum sync conflicts’ to review them."
        color: root.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    ]
  }

  ManagedFolderCard {
    id: backupCard
    width: parent.width
    foreground: root.foreground; background: root.background
    accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
    title: "Backup"
    description: "Creates a recovery copy after every local change."
    stateText: controller.backupStatusText()
    stateColor: root.backupService.backupState === "error" ? root.urgent
      : root.backupService.backupState === "healthy" ? "#22c55e" : root.foreground
    stateOpacity: root.backupService.backupState === "disabled" ? 0.58 : 1
    configured: root.backupService.enabled
    busy: root.backupService.busy
    directory: root.backupService.directory
    manageOpen: controller.backupManageOpen
    confirming: controller.confirmingBackupEnable || controller.confirmingBackupDisable
    folderDialogAvailable: controller.folderDialogAvailable
    changeLabel: "Change destination"
    removeLabel: "Disable…"
    emptyText: "No destination chosen"
    errorText: root.backupService.operationError !== "" ? root.backupService.operationError : root.backupService.statusError
    confirmationText: controller.confirmingBackupEnable
      ? "Keep the latest recovery copy at “"
        + controller.manualBackupDirectory.replace(/\/+$/, "") + "/pimpampum-latest.sqlite”?"
      : controller.confirmingBackupDisable
      ? "Stop automatic backups? The existing backup file will not be deleted."
      : ""
    confirmationUrgent: controller.confirmingBackupDisable
    secondaryVisible: controller.confirmingBackupEnable || controller.confirmingBackupDisable
    secondaryLabel: "Cancel"
    primaryLabel: controller.confirmingBackupEnable ? "Enable backup"
      : controller.confirmingBackupDisable ? "Confirm disable"
      : root.backupService.enabled ? "Back up now" : "Set up backup"
    primaryDestructive: controller.confirmingBackupDisable
    primaryEnabled: !root.backupService.busy
      && (root.backupService.enabled || controller.folderDialogAvailable)
    onOpenRequested: controller.runBackupAction("open")
    onManageToggled: controller.backupManageOpen = !controller.backupManageOpen
    onChangeRequested: { controller.backupManageOpen = false; controller.runBackupAction("choose") }
    onRemoveRequested: { controller.backupManageOpen = false; controller.runBackupAction("disable") }
    onSecondaryTriggered: controller.runBackupAction(controller.confirmingBackupEnable
      ? "cancel-enable" : "cancel-disable")
    onPrimaryTriggered: controller.runBackupAction(controller.confirmingBackupEnable ? "confirm-enable"
      : controller.confirmingBackupDisable ? "confirm-disable"
      : root.backupService.enabled ? "retry" : "choose")
  }

  PimpampumCard {
    width: parent.width
    foreground: root.foreground

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
      visible: controller.confirmingServiceStop
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
        visible: root.serviceControl.running || controller.confirmingServiceStop
        width: visible ? Math.max(implicitWidth, parent.width / 2 - parent.spacing / 2) : 0
        height: implicitHeight
        label: controller.confirmingServiceStop ? "Cancel" : "Restart service"
        foreground: root.foreground; background: root.background
        accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
        actionEnabled: !root.serviceControl.busy
        onTriggered: controller.runServiceAction(controller.confirmingServiceStop
          ? "cancel-stop" : "restart")
      }
      PimpampumSettingsButton {
        id: servicePrimaryAction
        width: Math.max(implicitWidth, parent.width - serviceSecondaryAction.width
          - (serviceSecondaryAction.visible ? parent.spacing : 0))
        height: implicitHeight
        primary: !root.serviceControl.running
        destructive: root.serviceControl.running
        label: controller.confirmingServiceStop ? "Stop Pimpampum"
          : root.serviceControl.running ? "Stop Pimpampum…" : "Start Pimpampum"
        foreground: root.foreground; background: root.background
        accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
        actionEnabled: !root.serviceControl.busy
        onTriggered: controller.runServiceAction(controller.confirmingServiceStop
          ? "confirm-stop" : root.serviceControl.running ? "stop" : "start")
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
    visible: !controller.folderDialogAvailable && !root.syncService.enabled
    width: parent.width
    wrapMode: Text.Wrap
    text: "Folder picker unavailable. Configure synchronization from the Pimpampum CLI."
    color: root.foreground
    opacity: 0.58
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
  Text {
    visible: !controller.folderDialogAvailable && !root.backupService.enabled
    width: parent.width
    wrapMode: Text.Wrap
    text: "Folder picker unavailable. Configure backup from the Pimpampum CLI."
    color: root.foreground
    opacity: 0.58
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
}
