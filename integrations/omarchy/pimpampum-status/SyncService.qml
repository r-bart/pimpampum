import QtQuick
import Quickshell.Io

Item {
  id: root
  required property string helperPath
  visible: false
  property bool popoutOpen: false
  property bool busy: false
  property bool enabled: false
  property bool paused: false
  property string directory: ""
  property string deviceId: ""
  property string syncState: "disabled"
  property string lastImportAt: ""
  property string lastExportAt: ""
  property int pendingCount: 0
  property int conflictCount: 0
  property string statusError: ""
  property string operationError: ""
  property string processOutput: ""
  property string processError: ""
  property string pendingOperation: ""

  function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) }
  function isAbsolutePath(value) { return typeof value === "string" && value.length > 1 && value.charAt(0) === "/" && value.indexOf("\u0000") === -1 }
  function validateStatus(value) {
    if (!isObject(value) || typeof value.enabled !== "boolean" || typeof value.paused !== "boolean") return false
    if (["disabled", "paused", "pending", "importing", "exporting", "healthy", "unavailable", "error", "conflict"].indexOf(value.state) === -1) return false
    if (value.directory !== null && !isAbsolutePath(value.directory)) return false
    if (value.deviceId !== null && (typeof value.deviceId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.deviceId))) return false
    if (typeof value.pendingSnapshotCount !== "number" || typeof value.conflictCount !== "number") return false
    return value.enabled === (value.directory !== null)
  }
  function fail(message) { busy = false; operationError = message; pendingOperation = "" }
  function acceptOutput(text) {
    var parsed
    try { parsed = JSON.parse(text) } catch (error) { fail("Pimpampum returned invalid synchronization status"); return }
    // The CLI wraps every success in {data}. Older installations emitted the payload
    // bare, so both shapes are accepted. A status payload never carries a data key.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && parsed.data && typeof parsed.data === "object") parsed = parsed.data
    if (!validateStatus(parsed)) { fail("Pimpampum returned invalid synchronization status"); return }
    enabled = parsed.enabled
    paused = parsed.paused
    directory = parsed.directory || ""
    deviceId = parsed.deviceId || ""
    syncState = parsed.state
    lastImportAt = parsed.lastImportAt || ""
    lastExportAt = parsed.lastExportAt || ""
    pendingCount = parsed.pendingSnapshotCount
    conflictCount = parsed.conflictCount
    statusError = parsed.error || ""
    operationError = ""
    pendingOperation = ""
    busy = false
  }
  function run(operation, path) {
    if (syncProcess.running) return
    if (!isAbsolutePath(helperPath)) { fail("Pimpampum synchronization helper path is invalid"); return }
    if (operation === "configure" && !isAbsolutePath(path)) { fail("Enter an absolute path"); return }
    var arguments = [helperPath, operation]
    if (operation === "configure") arguments.push(path)
    pendingOperation = operation
    processOutput = ""
    processError = ""
    operationError = ""
    busy = true
    syncProcess.command = arguments
    syncProcess.running = true
  }
  function refresh() { run("status", "") }
  function configure(path) { run("configure", path) }
  function syncNow() { run("now", "") }
  function setPaused(value) { run(value ? "pause" : "resume", "") }
  function forget() { run("forget", "") }
  function openDirectory() {
    operationError = ""
    if (!isAbsolutePath(directory)) { operationError = "Shared folder is unavailable"; return }
    if (directoryOpener.running) return
    directoryOpener.command = ["xdg-open", directory]
    directoryOpener.running = true
  }
  function handleExit(exitCode) {
    if (exitCode !== 0) {
      fail(actionableProcessError("Synchronization operation failed"))
      return
    }
    acceptOutput(processOutput)
  }
  function actionableProcessError(fallback) {
    if (typeof processError !== "string" || processError.length === 0 || processError.length > 4096) return fallback
    try {
      var envelope = JSON.parse(processError)
      if (!isObject(envelope) || !isObject(envelope.error)) return fallback
      var message = envelope.error.message
      if (typeof message !== "string" || message.length === 0 || message.length > 500) return fallback
      message = message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim()
      return message.length > 0 ? message : fallback
    } catch (error) { return fallback }
  }
  Component.onCompleted: refresh()
  Timer { interval: 10000; repeat: true; running: root.popoutOpen; onTriggered: root.refresh() }
  Process {
    id: syncProcess
    command: [root.helperPath, "status"]
    stdout: StdioCollector { onStreamFinished: root.processOutput = text }
    stderr: StdioCollector { onStreamFinished: root.processError = text }
    onExited: function(exitCode) { Qt.callLater(function() { root.handleExit(exitCode) }) }
  }
  Process {
    id: directoryOpener
    command: ["xdg-open", root.directory]
    onExited: function(exitCode) {
      if (exitCode !== 0) root.operationError = "Could not open the shared folder"
    }
  }
}
