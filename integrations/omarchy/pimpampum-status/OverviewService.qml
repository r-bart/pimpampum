import QtQuick
import Quickshell.Io

Item {
  id: root

  required property string helperPath
  visible: false
  property bool popoutOpen: false
  property var overview: null
  property string connectionState: "offline"
  property string errorMessage: "Pimpampum is offline"
  property double lastSuccessMs: 0
  property double currentMs: Date.now()
  property string processOutput: ""
  property string processError: ""
  readonly property var helperContract: ["pimpampum", "overview"]

  readonly property bool stale: overview !== null && connectionState !== "online"
  readonly property int activeClaims: overview && overview.counts ? overview.counts.activeClaims : 0
  readonly property string effectiveStatus: connectionState === "online" && overview
    ? overview.status
    : connectionState
  // The header rendered the raw state id, so a reader saw "incompatible" or "credentials" with no
  // idea what either meant. Every state gets the words it deserves, in the register "Stale"
  // already set beside it.
  readonly property var connectionLabels: ({
    "online": "Online",
    "offline": "Offline",
    "setup": "Not set up",
    "credentials": "Credentials rejected",
    "invalid": "Invalid response",
    "incompatible": "Incompatible version"
  })
  readonly property string connectionLabel: connectionLabels[connectionState] || connectionState

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  function isCount(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 0
  }

  function isString(value) {
    return typeof value === "string" && value.length > 0
  }

  function isTimestamp(value) {
    return isString(value) && !isNaN(Date.parse(value))
  }

  function isAbsoluteWorkspacePath(value) {
    return isString(value) && value.charAt(0) === "/" && value.indexOf("\u0000") === -1
  }

  function validCounts(counts) {
    if (!isObject(counts)) return false
    var fields = [
      "workspaces", "projects", "specs", "draftProjects", "openProjects",
      "pausedProjects", "completedProjects", "cancelledProjects", "openTasks",
      "completedTasks", "cancelledTasks", "activeClaims", "availableWork"
    ]
    for (var index = 0; index < fields.length; index += 1) {
      if (!isCount(counts[fields[index]])) return false
    }
    return true
  }

  function validProject(project) {
    if (!isObject(project) || !isObject(project.workspace)) return false
    if (!isString(project.id) || !isString(project.slug) || !isString(project.title)) return false
    if (["draft", "open", "paused", "done", "cancelled"].indexOf(project.lifecycleState) === -1) return false
    if (["active", "available", "draft", "paused", "complete"].indexOf(project.status) === -1) return false
    if (!isString(project.workspace.id) || !isString(project.workspace.name)) return false
    if (!isAbsoluteWorkspacePath(project.workspace.rootPath)) return false
    if (!isCount(project.specCount) || !isCount(project.openTaskCount) || !isCount(project.completedTaskCount)) return false
    if (!isCount(project.activeClaimCount) || !isCount(project.availableWorkCount)) return false
    return isTimestamp(project.updatedAt)
  }

  function validActiveWork(work) {
    if (!isObject(work)) return false
    if (["spec", "task"].indexOf(work.targetType) === -1) return false
    if (!isString(work.targetId) || !isString(work.workspaceId)) return false
    if (!isString(work.projectId) || !isString(work.projectTitle)) return false
    if (!isString(work.specId) || !isString(work.specTitle)) return false
    if (!isString(work.agentId) || !isTimestamp(work.expiresAt)) return false
    if (work.targetType === "task" && (!isString(work.taskId) || !isString(work.taskTitle))) return false
    if (work.targetType === "spec" && (work.taskId !== null || work.taskTitle !== null)) return false
    return true
  }

  function validSpec(spec) {
    if (!isObject(spec) || !isObject(spec.workspace)) return false
    if (!isString(spec.id) || !isString(spec.projectId) || !isString(spec.projectTitle)) return false
    if (["draft", "open", "paused", "done", "cancelled"].indexOf(spec.projectLifecycleState) === -1) return false
    if (!isString(spec.slug) || !isString(spec.title)) return false
    if (["draft", "ready", "done", "cancelled"].indexOf(spec.lifecycleState) === -1) return false
    if (!isString(spec.workspace.id) || !isString(spec.workspace.name)) return false
    if (!isAbsoluteWorkspacePath(spec.workspace.rootPath)) return false
    if (!isCount(spec.taskCount) || !isCount(spec.openTaskCount)) return false
    if (!isCount(spec.completedTaskCount) || !isCount(spec.activeClaimCount)) return false
    return isTimestamp(spec.updatedAt)
  }

  function validateEnvelope(envelope) {
    if (!isObject(envelope)) return "invalid"
    var data = envelope
    if (isObject(envelope.meta)) {
      // HTTP envelope: {meta, data}, independently versioned.
      if (!isObject(envelope.data)) return "invalid"
      if (envelope.meta.schemaVersion !== 2) return "incompatible"
      data = envelope.data
    } else if (isObject(envelope.data)) {
      // CLI envelope: {data}. A bare overview payload never carries a data key.
      data = envelope.data
    }
    if (vocabulary.overviewStates.indexOf(data.status) === -1) return "invalid"
    if (!isObject(data.daemon) || !isString(data.daemon.version) || !isTimestamp(data.daemon.startedAt)) return "invalid"
    if (!isCount(data.daemon.uptimeSeconds) || !isTimestamp(data.generatedAt)) return "invalid"
    if (!validCounts(data.counts) || !Array.isArray(data.projects) || !Array.isArray(data.specs) || !Array.isArray(data.activeWork)) return "invalid"
    if (typeof data.projectsTruncated !== "boolean" || typeof data.specsTruncated !== "boolean" || typeof data.activeWorkTruncated !== "boolean") return "invalid"
    if (data.projects.length > 500 || data.specs.length > 500 || data.activeWork.length > 500) return "invalid"

    for (var projectIndex = 0; projectIndex < data.projects.length; projectIndex += 1) {
      if (!validProject(data.projects[projectIndex])) return "invalid"
    }
    for (var workIndex = 0; workIndex < data.activeWork.length; workIndex += 1) {
      if (!validActiveWork(data.activeWork[workIndex])) return "invalid"
    }
    for (var specIndex = 0; specIndex < data.specs.length; specIndex += 1) {
      if (!validSpec(data.specs[specIndex])) return "invalid"
    }
    return "valid"
  }

  function acceptOutput(text) {
    var parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      fail("invalid", "Pimpampum returned invalid JSON")
      return
    }

    var validity = validateEnvelope(parsed)
    if (validity === "incompatible") {
      fail("incompatible", "Pimpampum uses an incompatible overview schema")
      return
    }
    if (validity !== "valid") {
      fail("invalid", "Pimpampum returned an invalid overview")
      return
    }

    overview = isObject(parsed.data) ? parsed.data : parsed
    connectionState = "online"
    errorMessage = ""
    lastSuccessMs = Date.now()
    currentMs = lastSuccessMs
  }

  function fail(state, message) {
    connectionState = state
    errorMessage = message
    currentMs = Date.now()
  }

  function refresh() {
    if (overviewProcess.running) return
    processOutput = ""
    processError = ""
    overviewProcess.running = true
  }

  /**
   * The helper's own reason, bounded to one line, or the generic sentence when it said nothing.
   * `pimpampum-control-route` prefixes every line with its name; the prefix is dropped so the card
   * reads as a sentence rather than as a shell transcript.
   */
  function installationMessage(text) {
    var line = text.split("\n")[0].trim()
    var separator = line.indexOf(": ")
    if (separator !== -1) line = line.slice(separator + 2).trim()
    if (line.length === 0 || line.length > 160) return "Pimpampum is not set up on this machine."
    return line.charAt(0).toUpperCase() + line.slice(1) + "."
  }

  function handleExit(exitCode) {
    if (exitCode !== 0) {
      var error = processError.toLowerCase()
      var credentialsRejected = error.indexOf("unauthorized") !== -1
        || error.indexOf("forbidden") !== -1
        || error.indexOf("valid bearer") !== -1
        || error.indexOf("credential") !== -1
        || /(^|[^0-9])(401|403)([^0-9]|$)/.test(error)
      if (credentialsRejected) {
        fail("credentials", "The saved credentials no longer match the local daemon.")
      } else if (exitCode === 69) {
        // 69 is the helper refusing before it reaches the daemon: the runtime is not installed,
        // its receipt is unsafe, or the control launcher is missing. This surface passes one
        // fixed argument, so 69 can never mean an argument error here. Calling it "offline"
        // blamed a daemon that is often running and hid the only remedy the user has.
        fail("setup", installationMessage(processError))
      } else fail("offline", "Pimpampum is offline")
      return
    }
    acceptOutput(processOutput)
  }

  Component.onCompleted: {
    if (helperPath.length < 2 || helperPath.charAt(0) !== "/") {
      fail("invalid", "Pimpampum overview helper path is invalid")
    } else refresh()
  }

  StateVocabulary { id: vocabulary }

  Timer {
    interval: root.popoutOpen ? 5000 : 10000
    repeat: true
    running: true
    onTriggered: root.refresh()
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.popoutOpen
    onTriggered: root.currentMs = Date.now()
  }

  Process {
    id: overviewProcess
    command: [root.helperPath]
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
}
