import QtQuick
import Quickshell.Io

// The half of BackupService and SyncService that does not depend on what the daemon reports: the
// helper process launched as one argument array, the exit handled on a deferred turn, the status
// reader that accepts both the bare payload and the {data} envelope, the folder opener and the
// typed-envelope error reader. A derived service names its subject and messages, declares the
// fields it owns, and defines `validateStatus(value)` (the exact shape it accepts) and
// `applyStatus(value)` (the copy of those fields); this base calls both.
Item {
  id: root

  required property string helperPath
  // Names the service in the generic messages: "Pimpampum returned invalid <subject> status".
  required property string subject
  required property string directoryUnavailableMessage
  required property string openFailureMessage
  // Used for a failed helper run that carries no typed envelope and whose operation has no entry
  // in `operationFailureMessages`.
  required property string operationFailedMessage
  property var operationFailureMessages: ({})
  visible: false
  property bool popoutOpen: false
  property bool busy: false
  property bool enabled: false
  property string directory: ""
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
      fail("Pimpampum returned invalid " + subject + " status")
      return
    }
    // The CLI wraps every success in {data}. Older installations emitted the payload
    // bare, so both shapes are accepted. A status payload never carries a data key.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && parsed.data && typeof parsed.data === "object") parsed = parsed.data
    if (!validateStatus(parsed)) {
      fail("Pimpampum returned invalid " + subject + " status")
      return
    }

    enabled = parsed.enabled
    directory = parsed.directory || ""
    applyStatus(parsed)
    statusError = parsed.error || ""
    operationError = ""
    pendingOperation = ""
    busy = false
  }

  function run(operation, path) {
    if (helperProcess.running) return
    if (!isAbsolutePath(helperPath)) {
      fail("Pimpampum " + subject + " helper path is invalid")
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
    helperProcess.command = arguments
    helperProcess.running = true
  }

  function refresh() {
    run("status", "")
  }

  function configure(path) {
    run("configure", path)
  }

  function openDirectory() {
    operationError = ""
    if (!isAbsolutePath(directory)) {
      operationError = directoryUnavailableMessage
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
      fail(actionableProcessError(
        operationFailureMessages[pendingOperation] || operationFailedMessage))
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
    id: helperProcess
    command: [root.helperPath, "status"]
    stdout: StdioCollector {
      onStreamFinished: root.processOutput = text
    }
    stderr: StdioCollector {
      onStreamFinished: root.processError = text
    }
    // Deferred: the collector publishes its text on the same turn the process exits, so reading
    // it synchronously here could observe an empty buffer.
    onExited: function(exitCode) {
      Qt.callLater(function() { root.handleExit(exitCode) })
    }
  }

  Process {
    id: directoryOpener
    command: ["xdg-open", root.directory]
    onExited: function(exitCode) {
      if (exitCode !== 0) root.operationError = root.openFailureMessage
    }
  }
}
