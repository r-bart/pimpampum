import QtQuick
import qs.Commons

Item {
  id: root

  required property var service
  property bool guided: false
  property color foreground: "white"
  property color background: "#202020"
  property color accent: "#3b82f6"
  property color urgent: "#ff5f57"
  property string fontFamily: "monospace"
  property string stage: guided ? "explanation" : "settings"
  property bool codexSelected: false
  property bool claudeCodeSelected: false
  property var pendingConnectors: []
  property var failedConnectors: []
  property int pendingIndex: 0
  property string conflictConnectorId: ""
  property string disconnectConnectorId: ""

  // Keep the visual and accessibility vocabulary identical across native surfaces.
  readonly property var stateLabels: [
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

  readonly property bool hasPartialFailure: failedConnectors.length > 0
  readonly property string progressLabel: service.busy
    ? "Connecting " + agentName(service.pendingConnectorId) + "…"
    : "Preparing agent connections…"

  implicitHeight: card.implicitHeight

  function agentName(connectorId) {
    return connectorId === "codex" ? "Codex" : "Claude Code"
  }

  function stateFor(connectorId) {
    return connectorId === "codex" ? service.codexState : service.claudeCodeState
  }

  function detected(connectorId) {
    var state = stateFor(connectorId)
    return state !== "Not installed" && state !== "Unsupported version"
      && state !== "Unavailable"
  }

  function selectDetectedAgents() {
    codexSelected = detected("codex")
    claudeCodeSelected = detected("claude-code")
  }

  function toggleSelection(connectorId) {
    if (service.busy || !detected(connectorId)) return
    if (connectorId === "codex") codexSelected = !codexSelected
    else claudeCodeSelected = !claudeCodeSelected
  }

  function selectedConnectors() {
    var selected = []
    if (codexSelected) selected.push("codex")
    if (claudeCodeSelected) selected.push("claude-code")
    return selected
  }

  function beginConfirmation() {
    if (selectedConnectors().length === 0) return
    stage = "confirmation"
  }

  function connectSelected() {
    pendingConnectors = selectedConnectors()
    failedConnectors = []
    pendingIndex = 0
    conflictConnectorId = ""
    stage = "progress"
    connectNext()
  }

  function connectNext() {
    if (pendingIndex >= pendingConnectors.length) {
      stage = hasPartialFailure ? "partial" : "complete"
      return
    }
    var connectorId = pendingConnectors[pendingIndex]
    if (stateFor(connectorId) === "Configuration conflict") {
      conflictConnectorId = connectorId
      stage = "conflict"
      return
    }
    service.connect(connectorId)
  }

  function retryFailures() {
    pendingConnectors = failedConnectors.slice(0)
    failedConnectors = []
    pendingIndex = 0
    stage = "progress"
    connectNext()
  }

  function runAgentAction(connectorId) {
    var state = stateFor(connectorId)
    if (state === "Connected" || state === "New session required") service.test(connectorId)
    else if (state === "Needs repair") service.repair(connectorId)
    else if (state === "Configuration conflict") {
      conflictConnectorId = connectorId
      stage = "conflict"
    } else service.connect(connectorId)
  }

  function requestDisconnect(connectorId) {
    if (service.busy) return
    disconnectConnectorId = connectorId
    stage = "disconnect-confirmation"
  }

  function confirmDisconnect() {
    var connectorId = disconnectConnectorId
    disconnectConnectorId = ""
    stage = "settings"
    service.disconnect(connectorId)
  }

  function resolveConflict(decision) {
    if (decision === "Replace") {
      stage = "progress"
      service.replace(conflictConnectorId)
    } else if (decision === "Keep existing") {
      conflictConnectorId = ""
      if (guided) {
        pendingIndex += 1
        stage = "progress"
        connectNext()
      } else stage = "settings"
    } else {
      conflictConnectorId = ""
      stage = guided ? "selection" : "settings"
    }
  }

  Connections {
    target: root.service
    function onOperationFinished(action, connectorId, succeeded) {
      if (action === "list") {
        root.selectDetectedAgents()
        return
      }
      if (root.stage !== "progress") return
      if (!succeeded && root.stateFor(connectorId) === "Configuration conflict") {
        root.conflictConnectorId = connectorId
        root.stage = "conflict"
        return
      }
      if (!succeeded && root.failedConnectors.indexOf(connectorId) === -1)
        root.failedConnectors = root.failedConnectors.concat([connectorId])
      root.pendingIndex += 1
      root.connectNext()
    }
  }

  Rectangle {
    id: card
    width: parent.width
    implicitHeight: cardContent.implicitHeight + Style.space(28)
    radius: Style.space(6)
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
    border.width: 1
    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

    Column {
      id: cardContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(14)
      spacing: Style.space(8)

      Text {
        text: root.guided ? "Connect your agents" : "Agents"
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
      }

      Text {
        visible: root.stage === "explanation"
        width: parent.width
        wrapMode: Text.Wrap
        text: "Pimpampum gives supported local agents the same project memory. Choose which detected agents to connect; nothing is sent to a remote service."
        color: root.foreground
        opacity: 0.72
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      PimpampumSettingsButton {
        visible: root.stage === "explanation"
        width: parent.width
        height: implicitHeight
        label: root.service.busy ? "Detecting agents…" : "Get started"
        primary: true
        foreground: root.foreground; background: root.background
        accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
        actionEnabled: !root.service.busy
        onTriggered: {
          root.stage = "selection"
          root.service.list()
        }
      }

      Column {
        visible: root.stage === "settings" || root.stage === "selection"
          || root.stage === "confirmation" || root.stage === "disconnect-confirmation"
        width: parent.width
        spacing: Style.space(6)

        Text {
          visible: root.stage === "selection"
          width: parent.width
          wrapMode: Text.Wrap
          text: "Detected agents are selected. Review the list before continuing."
          color: root.foreground; opacity: 0.72
          font.family: root.fontFamily; font.pixelSize: Style.font.caption
        }

        Repeater {
          model: ["codex", "claude-code"]
          delegate: Rectangle {
            required property string modelData
            width: cardContent.width
            height: agentRow.implicitHeight + Style.space(16)
            radius: Style.space(4)
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
            border.width: agentSelector.activeFocus ? 2 : 1
            border.color: agentSelector.activeFocus ? root.accent
              : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.1)

            Row {
              id: agentRow
              anchors.left: parent.left; anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.margins: Style.space(8)
              spacing: Style.space(8)
              Column {
                width: Math.max(0, parent.width - agentActions.width - parent.spacing)
                Text {
                  text: root.agentName(modelData)
                  color: root.foreground; font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall; font.bold: true
                }
                Text {
                  text: root.stateFor(modelData)
                  color: root.stateFor(modelData) === "Configuration conflict"
                    || root.stateFor(modelData) === "Needs repair" ? root.urgent : root.foreground
                  opacity: 0.72; font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
              Row {
                id: agentActions
                spacing: Style.space(4)
                PimpampumSettingsButton {
                  id: agentAction
                  width: implicitWidth; height: implicitHeight; compact: true
                  label: root.stage === "selection"
                    ? ((modelData === "codex" ? root.codexSelected : root.claudeCodeSelected)
                      ? "Selected" : "Select")
                    : root.stateFor(modelData) === "Connected"
                      || root.stateFor(modelData) === "New session required" ? "Test"
                    : root.stateFor(modelData) === "Needs repair" ? "Repair"
                    : root.stateFor(modelData) === "Configuration conflict" ? "Review"
                    : "Connect"
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: !root.service.busy && root.detected(modelData)
                  onTriggered: {
                    if (root.stage === "selection") root.toggleSelection(modelData)
                    else root.runAgentAction(modelData)
                  }
                }
                PimpampumSettingsButton {
                  visible: root.stage === "settings"
                    && (root.stateFor(modelData) === "Connected"
                      || root.stateFor(modelData) === "New session required"
                      || root.stateFor(modelData) === "Needs repair")
                  width: visible ? implicitWidth : 0; height: implicitHeight; compact: true
                  label: "Disconnect"; destructive: true
                  foreground: root.foreground; background: root.background
                  accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
                  actionEnabled: visible && !root.service.busy
                  onTriggered: root.requestDisconnect(modelData)
                }
              }
            }

            MouseArea {
              id: agentSelector
              anchors.fill: parent
              enabled: root.stage === "selection" && root.detected(modelData) && !root.service.busy
              hoverEnabled: true
              activeFocusOnTab: enabled
              cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
              Accessible.role: Accessible.CheckBox
              Accessible.name: "Select " + root.agentName(modelData)
              Accessible.checked: modelData === "codex" ? root.codexSelected : root.claudeCodeSelected
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                    || event.key === Qt.Key_Space) {
                  root.toggleSelection(modelData)
                  event.accepted = true
                }
              }
              onPressed: forceActiveFocus()
              onClicked: root.toggleSelection(modelData)
            }
          }
        }

        Text {
          visible: root.stage === "confirmation"
          width: parent.width; wrapMode: Text.Wrap
          text: "Connect the selected agents to this local Pimpampum installation? Existing unrelated settings stay unchanged."
          color: root.foreground; font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          visible: root.stage === "disconnect-confirmation"
          width: parent.width; wrapMode: Text.Wrap
          text: "Disconnect " + root.agentName(root.disconnectConnectorId)
            + " from Pimpampum? The daemon and all project data remain available."
          color: root.foreground; font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Row {
          visible: root.stage === "selection" || root.stage === "confirmation"
            || root.stage === "disconnect-confirmation"
          width: parent.width; spacing: Style.space(6)
          PimpampumSettingsButton {
            visible: root.stage === "confirmation" || root.stage === "disconnect-confirmation"
            width: visible ? implicitWidth : 0; height: implicitHeight
            label: "Cancel"
            foreground: root.foreground; background: root.background
            accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
            onTriggered: root.stage = root.stage === "disconnect-confirmation" ? "settings" : "selection"
          }
          PimpampumSettingsButton {
            width: Math.max(implicitWidth, parent.width - (root.stage === "confirmation" ? parent.children[0].width + parent.spacing : 0))
            height: implicitHeight; primary: true
            label: root.stage === "confirmation" ? "Connect selected agents"
              : root.stage === "disconnect-confirmation" ? "Disconnect agent" : "Continue"
            destructive: root.stage === "disconnect-confirmation"
            foreground: root.foreground; background: root.background
            accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
            actionEnabled: !root.service.busy
              && (root.stage === "disconnect-confirmation"
                || root.selectedConnectors().length > 0)
            onTriggered: {
              if (root.stage === "confirmation") root.connectSelected()
              else if (root.stage === "disconnect-confirmation") root.confirmDisconnect()
              else root.beginConfirmation()
            }
          }
        }
      }

      Column {
        visible: root.stage === "progress" || root.stage === "partial"
          || root.stage === "complete" || root.stage === "conflict"
        width: parent.width; spacing: Style.space(8)
        Text {
          width: parent.width; wrapMode: Text.Wrap
          text: root.stage === "progress" ? root.progressLabel
            : root.stage === "partial" ? "Some agents could not be connected. Connected agents remain available."
            : root.stage === "complete" ? "Agents are connected. Start a new agent session when requested."
            : "Configuration conflict"
          color: root.stage === "partial" || root.stage === "conflict" ? root.urgent : root.foreground
          font.family: root.fontFamily; font.pixelSize: Style.font.caption
        }
        Text {
          visible: root.stage === "conflict"
          width: parent.width; wrapMode: Text.Wrap
          text: root.agentName(root.conflictConnectorId)
            + " already has a different Pimpampum entry. Keep it, replace only that reviewed entry, or cancel."
          color: root.foreground; opacity: 0.72
          font.family: root.fontFamily; font.pixelSize: Style.font.caption
        }
        Row {
          visible: root.stage === "conflict"
          width: parent.width; spacing: Style.space(6)
          Repeater {
            model: ["Keep existing", "Replace", "Cancel"]
            delegate: PimpampumSettingsButton {
              required property string modelData
              width: (parent.width - parent.spacing * 2) / 3
              height: implicitHeight; compact: true
              label: modelData
              primary: modelData === "Replace"
              foreground: root.foreground; background: root.background
              accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
              onTriggered: root.resolveConflict(modelData)
            }
          }
        }
        PimpampumSettingsButton {
          visible: root.stage === "partial"
          width: parent.width; height: implicitHeight
          label: "Try again"; primary: true
          foreground: root.foreground; background: root.background
          accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
          onTriggered: root.retryFailures()
        }
        PimpampumSettingsButton {
          visible: root.stage === "complete"
          width: parent.width; height: implicitHeight
          label: root.guided ? "Done" : "Refresh agents"
          foreground: root.foreground; background: root.background
          accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
          onTriggered: {
            if (root.guided) root.stage = "settings"
            root.service.list()
          }
        }
      }

      Text {
        visible: root.service.errorMessage !== "" && root.stage !== "partial"
        width: parent.width; wrapMode: Text.Wrap
        text: root.service.errorMessage
        color: root.urgent; font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}
