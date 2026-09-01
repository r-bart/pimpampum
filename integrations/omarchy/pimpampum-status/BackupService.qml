import QtQuick
import Quickshell.Io

Item {
  id: root

  required property string helperPath
  visible: false
  property bool popoutOpen: false
  property bool busy: false
  property bool enabled: false
  property string directory: ""
  property string snapshotPath: ""
  property string backupState: "disabled"
  property string lastAttemptAt: ""
  property string lastSuccessAt: ""
  property string statusError: ""
  property string operationError: ""
  property string processOutput: ""
  property string processError: ""
  property string pendingOperation: ""

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  function isAbsolutePath(value) {
    return typeof value === "string" && value.length > 1
      && value.charAt(0) === "/" && value.indexOf("\u0000") === -1
  }

  function isNullableTimestamp(value) {
    return value === null || (typeof value === "string" && !isNaN(Date.parse(value)))
  }

  function validateStatus(value) {
    if (!isObject(value) || typeof value.enabled !== "boolean") return false
    if (["disabled", "pending", "healthy", "error"].indexOf(value.state) === -1) return false
    if (value.directory !== null && !isAbsolutePath(value.directory)) return false
    if (value.snapshotPath !== null && !isAbsolutePath(value.snapshotPath)) return false
    if (!isNullableTimestamp(value.lastAttemptAt) || !isNullableTimestamp(value.lastSuccessAt)) return false
    if (value.error !== null && (typeof value.error !== "string" || value.error.length === 0
        || value.error.length > 500)) return false
    if (value.enabled !== (value.directory !== null)) return false
    if (value.enabled) return value.state !== "disabled" && isAbsolutePath(value.snapshotPath)
    if (value.snapshotPath !== null) return false
    // Off with nothing, or `error` with a message and no destination: the daemon could not read
    // its settings file (M-C6) and the card shows the reason under "Backup needs attention".
    if (value.state === "disabled") return value.error === null
    return value.state === "error" && value.error !== null
  }

  function fail(message) {
    busy = false
    operationError = message
    pendingOperation = ""
  }

  function acceptOutput(text) {
    var parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      fail("Pimpampum returned invalid backup status")
      return
    }
    // The CLI wraps every success in {data}. Older installations emitted the payload
    // bare, so both shapes are accepted. A status payload never carries a data key.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && parsed.data && typeof parsed.data === "object") parsed = parsed.data
    if (!validateStatus(parsed)) {
      fail("Pimpampum returned invalid backup status")
      return
    }

    enabled = parsed.enabled
    directory = parsed.directory || ""
    snapshotPath = parsed.snapshotPath || ""
    backupState = parsed.state
    lastAttemptAt = parsed.lastAttemptAt || ""
    lastSuccessAt = parsed.lastSuccessAt || ""
    statusError = parsed.error || ""
    operationError = ""
    pendingOperation = ""
    busy = false
  }

  function run(operation, path) {
    if (backupProcess.running) return
    if (helperPath.length < 2 || helperPath.charAt(0) !== "/") {
      fail("Pimpampum backup helper path is invalid")
      return
    }
    if (operation === "configure" && !isAbsolutePath(path)) {
      fail("Enter an absolute path")
      return
    }

    var arguments = [helperPath, operation]
    if (operation === "configure") arguments.push(path)
    pendingOperation = operation
    processOutput = ""
    processError = ""
    operationError = ""
    busy = true
    backupProcess.command = arguments
    backupProcess.running = true
  }

  function refresh() {
    run("status", "")
  }

  function configure(path) {
    run("configure", path)
  }

  function retry() {
    run("retry", "")
  }

  function disable() {
    run("disable", "")
  }

  function openDirectory() {
    operationError = ""
    if (!isAbsolutePath(directory)) {
      operationError = "Backup directory is unavailable"
      return
    }
    if (directoryOpener.running) {
      return
    }
    var arguments = ["xdg-open", directory]
    directoryOpener.command = arguments
    directoryOpener.running = true
  }

  function handleExit(exitCode) {
    if (exitCode !== 0) {
      var messages = ({
        "status": "Could not read automatic backup settings",
        "configure": "Could not configure that backup directory",
        "retry": "Could not refresh the backup",
        "disable": "Could not disable automatic backup"
      })
      fail(actionableProcessError(messages[pendingOperation] || "Automatic backup operation failed"))
      return
    }
    acceptOutput(processOutput)
  }

  function actionableProcessError(fallback) {
    if (typeof processError !== "string" || processError.length === 0 || processError.length > 4096)
      return fallback
    try {
      var envelope = JSON.parse(processError)
      if (!isObject(envelope) || !isObject(envelope.error)) return fallback
      var message = envelope.error.message
      if (typeof message !== "string" || message.length === 0 || message.length > 500)
        return fallback
      message = message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .replace(/\s+/g, " ").trim()
      return message.length > 0 ? message : fallback
    } catch (error) {
      return fallback
    }
  }

  Component.onCompleted: root.refresh()

  Timer {
    interval: 10000
    repeat: true
    running: root.popoutOpen
    onTriggered: root.refresh()
  }

  Process {
    id: backupProcess
    command: [root.helperPath, "status"]
    stdout: StdioCollector {
      onStreamFinished: root.processOutput = text
    }
    stderr: StdioCollector {
      onStreamFinished: root.processError = text
    }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.handleExit(exitCode) })
    }
  }

  Process {
    id: directoryOpener
    command: ["xdg-open", root.directory]
    onExited: function(exitCode) {
      if (exitCode !== 0) root.operationError = "Could not open the backup directory"
    }
  }
}
