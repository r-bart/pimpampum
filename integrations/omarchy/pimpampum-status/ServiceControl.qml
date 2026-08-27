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

  function refresh() { run("status") }
  function start() { run("start") }
  function stop() { run("stop") }
  function restart() { run("restart") }

  function run(operation) {
    if (serviceProcess.running) return
    operationError = ""
    pendingOperation = operation
    busy = true
    output.text = ""
    serviceProcess.command = [helperPath, operation]
    serviceProcess.running = true
  }

  function accept(exitCode) {
    busy = false
    var parsed
    try { parsed = JSON.parse(output.text.trim()) }
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
    stdout: StdioCollector { id: output }
    onExited: function(exitCode) { root.accept(exitCode) }
  }
}
