import QtQuick
import Quickshell.Io

Item {
  id: root

  required property string helperPath
  visible: false

  readonly property int operationTimeoutMs: 35000
  readonly property bool busy: connectionProcess.running
  property string pendingAction: ""
  property string pendingConnectorId: ""
  property string processOutput: ""
  property string processError: ""
  property string errorMessage: ""
  property string codexState: "Not installed"
  property string claudeCodeState: "Not installed"
  property bool initialized: false
  property var resultPayload: null
  property bool ignoreNextExit: false

  signal operationFinished(string action, string connectorId, bool succeeded)

  readonly property var sharedStates: [
    "Not installed",
    "Not connected",
    "Connecting",
    "Connected",
    "New session required",
    "Needs repair",
    "Configuration conflict",
    "Unsupported version",
    "Unavailable"
  ]

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  function validConnectorId(value) {
    return value === "codex" || value === "claude-code"
  }

  function validAction(value) {
    return ["list", "plan", "connect", "test", "repair", "disconnect", "resume"]
      .indexOf(value) !== -1
  }

  function displayState(value) {
    if (!isObject(value)) return "Needs repair"
    if (value.newSessionRequired === true) return "New session required"
    switch (value.state) {
    case "notInstalled": return "Not installed"
    case "unavailable": return "Unavailable"
    case "notConnected":
    case "absent": return "Not connected"
    case "ownedCurrent":
    case "equivalentUnowned": return value.available === true ? "Connected" : "Needs repair"
    case "connected":
    case "verified": return "Connected"
    case "ownedStale": return "Needs repair"
    case "needsRepair": return "Needs repair"
    case "conflict": return "Configuration conflict"
    case "unsupportedVersion": return "Unsupported version"
    default: return "Needs repair"
    }
  }

  function setState(connectorId, state) {
    if (sharedStates.indexOf(state) === -1) state = "Needs repair"
    if (connectorId === "codex") codexState = state
    else if (connectorId === "claude-code") claudeCodeState = state
  }

  function fail(message) {
    operationDeadline.stop()
    pendingAction = ""
    pendingConnectorId = ""
    errorMessage = message
  }

  function rejectCurrent(message) {
    var failedAction = pendingAction
    var failedConnectorId = pendingConnectorId
    fail(message)
    operationFinished(failedAction, failedConnectorId, false)
  }

  function run(action, connectorId, replaceReviewed) {
    if (busy) return
    if (!validAction(action)) {
      fail("Unsupported connection action")
      return
    }
    var needsConnector = action !== "list" && action !== "resume"
    if (needsConnector && !validConnectorId(connectorId)) {
      fail("Unsupported agent connection")
      return
    }
    if (replaceReviewed === true && action !== "repair") {
      fail("Unsupported conflict decision")
      return
    }
    if (helperPath.length < 2 || helperPath.charAt(0) !== "/") {
      fail("Pimpampum connection helper is unavailable")
      return
    }

    pendingAction = action
    pendingConnectorId = needsConnector ? connectorId : ""
    processOutput = ""
    processError = ""
    errorMessage = ""
    resultPayload = null
    if (action === "connect" || action === "repair") setState(connectorId, "Connecting")
    var arguments = [helperPath, action]
    if (needsConnector) arguments.push(connectorId)
    if (replaceReviewed === true) arguments.push("replace")
    connectionProcess.command = arguments
    connectionProcess.running = true
    operationDeadline.restart()
  }

  function list() { run("list", "") }
  function plan(connectorId) { run("plan", connectorId) }
  function connect(connectorId) { run("connect", connectorId) }
  function test(connectorId) { run("test", connectorId) }
  function repair(connectorId) { run("repair", connectorId) }
  function replace(connectorId) { run("repair", connectorId, true) }
  function disconnect(connectorId) { run("disconnect", connectorId) }
  function resume() { run("resume", "") }

  function unwrapResult(value) {
    if (!isObject(value)) return null
    if (isObject(value.data)) return value.data
    return value
  }

  function acceptResult(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > 65536) {
      rejectCurrent("Pimpampum returned an invalid connection response")
      return
    }
    var envelope
    try { envelope = JSON.parse(text) }
    catch (error) { rejectCurrent("Pimpampum returned an invalid connection response"); return }
    if (!isObject(envelope) || envelope.schemaVersion !== 1 || envelope.ok !== true
        || !validAction(envelope.action)
        || (envelope.connectorId !== null && !validConnectorId(envelope.connectorId))
        || !isObject(envelope.result)) {
      rejectCurrent("Pimpampum returned an invalid connection response")
      return
    }

    var data = unwrapResult(envelope.result)
    resultPayload = data
    var connections = Array.isArray(data) ? data
      : isObject(data) && Array.isArray(data.connections) ? data.connections
      : isObject(data) && Array.isArray(data.connectors) ? data.connectors : []
    for (var index = 0; index < connections.length && index < 2; index += 1) {
      var connection = connections[index]
      if (isObject(connection) && validConnectorId(connection.id))
        setState(connection.id, displayState(connection))
    }
    if (validConnectorId(envelope.connectorId)) {
      if (envelope.action === "disconnect") setState(envelope.connectorId, "Not connected")
      else if (connections.length === 0 && isObject(data) && typeof data.state === "string")
        setState(envelope.connectorId, displayState(data))
    }
    if (envelope.action === "list") initialized = true
    var completedAction = pendingAction
    var completedConnectorId = pendingConnectorId
    operationDeadline.stop()
    pendingAction = ""
    pendingConnectorId = ""
    errorMessage = ""
    operationFinished(completedAction, completedConnectorId, true)
  }

  function boundedCliCode(value) {
    return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : ""
  }

  function boundedCliMessage(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 200) return ""
    return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim()
  }

  // The helper forwards the CLI's typed error code and one bounded line of its message, like the
  // other services read `error.message` from the CLI's stderr envelope. A stopped daemon, a
  // missing agent CLI and a real connector failure therefore no longer read alike.
  function actionableProcessError(envelope, fallback) {
    var cliCode = boundedCliCode(envelope.cliCode)
    var message = boundedCliMessage(envelope.message)
    if (cliCode === "unavailable")
      return "Pimpampum is not running. Start the service from Settings and retry."
    if (cliCode === "unauthorized")
      return "The saved credentials no longer match the local daemon. Run pimpampum install."
    if (cliCode === "not_found" || /not installed/i.test(message))
      return "The agent's command-line tool is not installed."
    if (cliCode === "conflict") return "The agent connection changed and needs another review"
    return message.length > 0 ? message : fallback
  }

  function acceptFailure(text) {
    var message = "Agent connection operation failed"
    var failedState = "Needs repair"
    if (typeof text === "string" && text.length > 0 && text.length <= 4096) {
      try {
        var envelope = JSON.parse(text)
        if (isObject(envelope) && envelope.schemaVersion === 1 && envelope.ok === false) {
          if (envelope.code === "operation_in_progress") message = "Another connection action is still running"
          else if (envelope.code === "runtime_not_installed") message = "Pimpampum is not installed"
          else if (envelope.code === "timeout") message = "The connection action took too long"
          else if (envelope.code === "connector_conflict") {
            message = "The agent connection changed and needs another review"
            failedState = "Configuration conflict"
          }
          else if (envelope.code === "command_failed") {
            message = actionableProcessError(envelope, message)
            if (boundedCliCode(envelope.cliCode) === "unavailable") failedState = "Unavailable"
          }
        }
      } catch (error) {}
    }
    var failedAction = pendingAction
    var failedConnectorId = pendingConnectorId
    if (validConnectorId(failedConnectorId)) setState(failedConnectorId, failedState)
    fail(message)
    operationFinished(failedAction, failedConnectorId, false)
  }

  function handleExit(exitCode) {
    if (ignoreNextExit) { ignoreNextExit = false; return }
    if (exitCode !== 0) { acceptFailure(processError); return }
    acceptResult(processOutput)
  }

  Timer {
    id: operationDeadline
    interval: root.operationTimeoutMs
    repeat: false
    onTriggered: {
      if (!connectionProcess.running) return
      root.ignoreNextExit = true
      connectionProcess.running = false
      if (root.validConnectorId(root.pendingConnectorId))
        root.setState(root.pendingConnectorId, "Needs repair")
      root.rejectCurrent("The connection action took too long")
    }
  }

  Process {
    id: connectionProcess
    stdout: StdioCollector { onStreamFinished: root.processOutput = text }
    stderr: StdioCollector { onStreamFinished: root.processError = text }
    onExited: function(exitCode) {
      Qt.callLater(function() { root.handleExit(exitCode) })
    }
  }
}
