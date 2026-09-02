import QtQuick
import Quickshell.Io

Item {
  id: root

  required property string helperPath
  required property bool popoutOpen
  property bool running: false
  property bool busy: false
  property string pendingOperation: ""
  property string operationError: ""
  property string processOutput: ""

  function refresh() { run("status") }
  function start() { run("start") }
  function stop() { run("stop") }
  function restart() { run("restart") }

  function run(operation) {
    if (serviceProcess.running) return
    operationError = ""
    pendingOperation = operation
    busy = true
    processOutput = ""
    serviceProcess.command = [helperPath, operation]
    serviceProcess.running = true
  }

  function accept(exitCode) {
    busy = false
    var parsed
    try { parsed = JSON.parse(processOutput.trim()) }
    catch (error) { operationError = "Could not read the Pimpampum service state"; return }
    if (exitCode !== 0 || !parsed || Object.keys(parsed).length !== 1
        || typeof parsed.running !== "boolean") {
      operationError = "Could not update the Pimpampum service"
      return
    }
    running = parsed.running
    pendingOperation = ""
  }

  onPopoutOpenChanged: if (popoutOpen) refresh()

  Process {
    id: serviceProcess
    command: [root.helperPath, "status"]
    stdout: StdioCollector { onStreamFinished: root.processOutput = text }
    // Deferred like the sibling services: the collector publishes its text on the same turn the
    // process exits, so reading it synchronously here could observe an empty buffer.
    onExited: function(exitCode) {
      Qt.callLater(function() { root.accept(exitCode) })
    }
  }
}
