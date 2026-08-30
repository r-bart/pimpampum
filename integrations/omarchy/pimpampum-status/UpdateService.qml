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
    root.operation = operation
    process.command = [helperPath, operation]
    state = operation === "install" ? "installing" : "checking"
    process.running = true
  }
  property string processOutput: ""
  Process {
    id: process
    stdout: StdioCollector { onStreamFinished: root.processOutput = text }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.handleExit(exitCode) })
    }
  }

  function handleExit(exitCode) {
    if (exitCode !== 0) { root.state = "error"; root.errorMessage = "Could not check for updates"; return }
    try {
      var envelope = JSON.parse(root.processOutput)
      var data = envelope.data
      root.currentVersion = data.installedVersion || data.currentVersion || ""
      root.latestVersion = data.latestVersion || ""
      root.state = root.operation === "install" ? "current" : (data.updateAvailable ? "available" : "current")
    } catch (error) { root.state = "error"; root.errorMessage = "Pimpampum returned an invalid update response" }
  }
}
