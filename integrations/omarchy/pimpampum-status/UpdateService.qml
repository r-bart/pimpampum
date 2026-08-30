import QtQuick
import Quickshell.Io

Item {
  id: root
  required property string helperPath
  visible: false
  property string state: "unchecked"
  property string currentVersion: ""
  property string latestVersion: ""
  property string errorMessage: ""
  property string operation: ""
  property string processError: ""
  // Only the read-only check is bounded. Killing a half-finished install is worse than waiting,
  // because npm may already have replaced the package it is reconciling.
  readonly property int checkTimeoutMs: 90000
  property bool timedOut: false
  readonly property bool busy: process.running
  readonly property bool updateAvailable: state === "available"

  function run(operation) {
    if (busy) return
    if (helperPath.length === 0 || helperPath.charAt(0) !== "/") {
      state = "error"
      errorMessage = "Update helper is unavailable"
      return
    }
    errorMessage = ""
    processOutput = ""
    processError = ""
    timedOut = false
    root.operation = operation
    process.command = [helperPath, operation]
    state = operation === "install" ? "installing" : "checking"
    process.running = true
    if (operation !== "install") checkDeadline.restart()
  }

  Timer {
    id: checkDeadline
    interval: root.checkTimeoutMs
    repeat: false
    // The state is settled here rather than in handleExit, so a terminated child that never
    // reports an exit cannot leave the popout stuck on "Checking…".
    onTriggered: {
      if (!process.running) return
      root.timedOut = true
      root.state = "error"
      root.errorMessage = "The update check took too long. Retry when the network responds."
      process.running = false
    }
  }
  property string processOutput: ""
  Process {
    id: process
    stdout: StdioCollector { onStreamFinished: root.processOutput = text }
    stderr: StdioCollector { onStreamFinished: root.processError = text }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.handleExit(exitCode) })
    }
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  // The CLI writes its typed envelope to stderr and leaves stdout empty on a failure, so a reader
  // that only parsed stdout reported every npm refusal as a generic message. Same bounds as
  // BackupService: the text comes from npm and is rendered on one line of the popout.
  function actionableFailure(stream, fallback) {
    if (typeof stream !== "string" || stream.length === 0 || stream.length > 4096) return fallback
    try {
      var envelope = JSON.parse(stream)
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

  function handleExit(exitCode) {
    checkDeadline.stop()
    // The deadline already published the cause; a terminated child also exits non-zero.
    if (root.timedOut) return
    if (exitCode !== 0) {
      root.state = "error"
      var fallback = root.operation === "install"
        ? "Could not install the update" : "Could not check for updates"
      if (root.processError.indexOf("CLI unavailable") !== -1) {
        root.errorMessage = "Pimpampum CLI is unavailable. Reinstall Pimpampum and retry."
      } else {
        root.errorMessage = root.actionableFailure(
          root.processError, root.actionableFailure(root.processOutput, fallback))
      }
      console.warn("Pimpampum update command failed with exit code", exitCode)
      return
    }
    try {
      var envelope = JSON.parse(root.processOutput)
      var data = envelope.data
      root.currentVersion = data.installedVersion || data.currentVersion || ""
      root.latestVersion = data.latestVersion || ""
      root.state = root.operation === "install" ? "current" : (data.updateAvailable ? "available" : "current")
    } catch (error) { root.state = "error"; root.errorMessage = "Pimpampum returned an invalid update response" }
  }
}
