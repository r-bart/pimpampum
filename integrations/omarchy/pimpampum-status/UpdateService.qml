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
  // The one machine-readable remedy the CLI names: `details.remedy` of the typed `unavailable`
  // rejection the Linux `update` verb returns, because the Omarchy plugin owns that runtime and
  // `pimpampum-bootstrap` installs the pinned version. Empty for every other failure.
  property string remedy: ""
  property string operation: ""
  property string processError: ""
  // Only the read-only check is bounded. Killing a half-finished install is worse than waiting,
  // because the release provider may already have replaced the runtime it is reconciling.
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
    remedy = ""
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
  // that only parsed stdout reported every provider refusal as a generic message. Same bounds as
  // BackupService: the text comes from the release provider and is rendered on one popout line.
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

  // `details.remedy` names a helper of this plugin, so it is accepted only as a bare helper name
  // and only for the typed `unavailable` code; the popout resolves it against its own directory.
  function actionableRemedy(stream) {
    if (typeof stream !== "string" || stream.length === 0 || stream.length > 4096) return ""
    try {
      var envelope = JSON.parse(stream)
      if (!isObject(envelope) || !isObject(envelope.error)) return ""
      if (envelope.error.code !== "unavailable" || !isObject(envelope.error.details)) return ""
      var remedy = envelope.error.details.remedy
      return typeof remedy === "string" && /^pimpampum-[a-z]{1,40}$/.test(remedy) ? remedy : ""
    } catch (error) {
      return ""
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
        root.remedy = root.actionableRemedy(root.processError)
      }
      console.warn("Pimpampum update command failed with exit code", exitCode)
      return
    }
    try {
      var envelope = JSON.parse(root.processOutput)
      // The CLI prints `{data}`; a bare payload must keep working so an installed plugin survives
      // a CLI upgrade in either direction, like every other reader in this plugin.
      var data = isObject(envelope) && isObject(envelope.data) ? envelope.data : envelope
      if (!isObject(data)) throw new Error("invalid update response")
      root.currentVersion = data.installedVersion || data.currentVersion || ""
      root.latestVersion = data.latestVersion || ""
      root.state = root.operation === "install" ? "current" : (data.updateAvailable ? "available" : "current")
    } catch (error) { root.state = "error"; root.errorMessage = "Pimpampum returned an invalid update response" }
  }
}
