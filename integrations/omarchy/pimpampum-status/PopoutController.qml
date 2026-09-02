import QtQuick
import Quickshell
import Quickshell.Io

// Every flag and function of the status popout, and the three processes they drive: the isolated
// folder picker, the workspace opener and the bounded workspace registration. StatusPopout owns
// the window, the header and the footer; the pages it loads read this controller and call it.
QtObject {
  id: root

  required property var service
  required property var backupService
  required property var syncService
  required property var serviceControl
  required property var updateService
  required property var connectionService

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
  property string pendingWorkspaceFolder: ""
  property string workspaceRegistrationError: ""
  property string workspaceRegistrationNotice: ""
  property string workspaceRegistrarOutput: ""
  property string workspaceRegistrarError: ""

  readonly property string pickerHelperPath: decodeURIComponent(
    Qt.resolvedUrl("pimpampum-folder-picker").toString().replace(/^file:\/\//, "")
  )
  readonly property string controlRoutePath: decodeURIComponent(
    Qt.resolvedUrl("pimpampum-control-route").toString().replace(/^file:\/\//, "")
  )
  // The plugin directory, for the one remedy the Updates card can name: the bootstrap helper
  // that installs the pinned runtime lives next to the folder picker.
  readonly property string pluginDirectory: pickerHelperPath.replace(/\/[^/]+$/, "")
  // The receipt-owned control launcher is the only `pimpampum` a native install has, and nothing
  // links it onto PATH. The empty state spells its absolute path so the command can be copied as
  // is; a bare `pimpampum` sent users to install the Node package instead.
  readonly property string homeDirectory: Quickshell.env("HOME") || ""
  readonly property string controlLauncherPath: homeDirectory.charAt(0) === "/"
    ? homeDirectory + "/.local/share/pimpampum/bin/pimpampum-control"
    : "pimpampum-control"
  readonly property bool folderDialogOpen: folderPicker.running
  readonly property bool folderDialogAvailable: pickerHelperPath.charAt(0) === "/"
  readonly property bool registeringWorkspace: workspaceRegistrar.running

  // Emitted when a view switch must start at the top; StatusPopout owns the Flickable.
  signal scrollToTop()

  function open() {
    if (opened) return
    opened = true
    workspaceRegistrationError = ""
    workspaceRegistrationNotice = ""
    service.refresh()
    backupService.refresh()
    syncService.refresh()
    connectionService.list()
  }

  function chooseDirectory(target) {
    if (folderPicker.running || !folderDialogAvailable) return
    pendingFolderTarget = target
    folderPickerOutput = ""
    folderPicker.command = [pickerHelperPath,
      target === "backup" ? "Choose a backup destination"
        : target === "workspace" ? "Choose a workspace folder"
        : "Choose a provider-synced location"]
    folderPicker.running = true
  }

  function acceptFolderPicker(exitCode) {
    if (exitCode === 1) return
    var path = folderPickerOutput.trim()
    if (exitCode !== 0 || !backupService.isAbsolutePath(path)) {
      if (pendingFolderTarget === "backup") backupService.operationError = "Folder picker unavailable; configure backup from the Pimpampum CLI"
      else if (pendingFolderTarget === "workspace") workspaceRegistrationError = "Folder picker unavailable; add the workspace with the command below"
      else syncService.operationError = "Folder picker unavailable; configure synchronization from the Pimpampum CLI"
      return
    }
    if (pendingFolderTarget === "backup") {
      manualBackupDirectory = path
      confirmingBackupEnable = true
    } else if (pendingFolderTarget === "workspace") {
      registerWorkspace(path)
    } else {
      manualSyncDirectory = path
      confirmingSyncEnable = true
    }
  }

  // The chosen folder goes to the bounded route as one argv element; the route derives the
  // workspace id and name and the daemon validates both again. Nothing here builds a shell string.
  function registerWorkspace(path) {
    workspaceRegistrationError = ""
    workspaceRegistrationNotice = ""
    if (!isSafeWorkspacePath(path)) return void (workspaceRegistrationError = "Workspace folder is unavailable")
    if (controlRoutePath.charAt(0) !== "/") return void (workspaceRegistrationError = "Pimpampum control route is unavailable")
    if (workspaceRegistrar.running) return
    pendingWorkspaceFolder = path
    workspaceRegistrarOutput = ""
    workspaceRegistrarError = ""
    var arguments = [controlRoutePath, "workspace", "add"]
    arguments.push(path)
    workspaceRegistrar.command = arguments
    workspaceRegistrar.running = true
  }

  function acceptWorkspaceRegistration(exitCode) {
    if (exitCode !== 0) {
      // The CLI writes its typed envelope to stderr and leaves stdout empty on a failure; the
      // route itself writes one plain line there.
      workspaceRegistrationError = updateService.actionableFailure(workspaceRegistrarError,
        updateService.actionableFailure(workspaceRegistrarOutput, "Could not add the workspace"))
      return
    }
    var name = ""
    try {
      var envelope = JSON.parse(workspaceRegistrarOutput)
      var data = updateService.isObject(envelope) && updateService.isObject(envelope.data)
        ? envelope.data : envelope
      if (updateService.isObject(data) && typeof data.name === "string" && data.name.length <= 120)
        name = data.name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
    } catch (error) {
      name = ""
    }
    workspaceRegistrationNotice = name.length > 0
      ? "Workspace added: " + name : "Workspace added"
    service.refresh()
  }

  function syncStatusText() {
    if (syncService.busy) return ({
      "configure": "Enabling synchronization…", "now": "Synchronizing…",
      "pause": "Pausing synchronization…", "resume": "Resuming synchronization…",
      "forget": "Forgetting shared folder…", "status": "Checking synchronization…"
    })[syncService.pendingOperation] || "Updating synchronization…"
    return vocabulary.syncStateLabels[syncService.syncState] || "Synchronization unavailable"
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
    var label = vocabulary.backupStateLabels[backupService.backupState] || "Backup unavailable"
    if (backupService.backupState !== "healthy" || backupService.lastSuccessAt === "") return label
    return label + " · " + new Date(backupService.lastSuccessAt).toLocaleTimeString()
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
    scrollToTop()
    if (value) {
      manualSyncDirectory = syncService.directory
      manualBackupDirectory = backupService.directory
      syncService.refresh()
      backupService.refresh()
      connectionService.list()
    }
  }

  function showHelp(value) {
    helpView = value
    scrollToTop()
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

  readonly property StateVocabulary vocabulary: StateVocabulary {}

  readonly property Process folderPicker: Process {
    command: [root.pickerHelperPath, "Choose a folder"]
    stdout: StdioCollector { onStreamFinished: root.folderPickerOutput = text }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.acceptFolderPicker(exitCode) })
    }
  }

  readonly property Process workspaceOpener: Process {
    command: ["xdg-open", root.pendingWorkspacePath]
    onExited: function(exitCode) {
      if (exitCode !== 0) root.revealError = "Could not open the workspace directory"
    }
  }

  readonly property Process workspaceRegistrar: Process {
    command: [root.controlRoutePath, "workspace", "add", root.pendingWorkspaceFolder]
    stdout: StdioCollector { onStreamFinished: root.workspaceRegistrarOutput = text }
    stderr: StdioCollector { onStreamFinished: root.workspaceRegistrarError = text }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.acceptWorkspaceRegistration(exitCode) })
    }
  }
}
