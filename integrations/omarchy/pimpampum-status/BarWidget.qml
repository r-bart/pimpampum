import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "dev.pimpampum.status"

  readonly property string helperPath: decodeURIComponent(
    Qt.resolvedUrl("pimpampum-overview").toString().replace(/^file:\/\//, "")
  )
  readonly property bool isVertical: bar ? bar.vertical : false
  readonly property color themeForeground: bar ? bar.foreground : "white"
  readonly property color themeBackground: bar ? bar.background : "#202020"
  readonly property color themeUrgent: bar ? bar.urgent : "#ff5f57"
  readonly property color completedGreen: "#22c55e"
  readonly property string themeFont: bar ? bar.fontFamily : "monospace"
  readonly property string barPosition: bar ? bar.position : "top"
  readonly property real inheritedBarSize: bar ? bar.barSize : 26
  readonly property string baseStatusLabel: ({
        "active": "Active work",
        "available": "Work available",
        "complete": "All complete",
        "draft": "Drafts only",
        "empty": "No projects",
        "offline": "Offline",
        "credentials": "Credentials rejected",
        "invalid": "Invalid response",
        "incompatible": "Incompatible version"
      }[service.effectiveStatus] || "Unavailable")
  readonly property string statusLabel: service.stale
    ? "Stale · " + baseStatusLabel
    : baseStatusLabel
  readonly property string statusIcon: ({
    "active": "●",
    "available": "◐",
    "complete": "✓",
    "draft": "○",
    "empty": "–",
    "offline": "×",
    "credentials": "!",
    "invalid": "!",
    "incompatible": "!"
  }[service.effectiveStatus] || "?")
  readonly property color statusColor: service.connectionState !== "online"
    ? root.themeUrgent
    : service.effectiveStatus === "complete" ? root.completedGreen : root.themeForeground

  readonly property bool opened: popout.opened

  // StatusPopout owns the bar.requestPopout/bar.releasePopout lifecycle.
  function open() { popout.open() }
  function close() { popout.close() }
  function closeForPopoutSwitch() { popout.close() }
  function togglePanel() { popout.toggle() }

  implicitWidth: isVertical ? inheritedBarSize : indicator.implicitWidth + Style.space(12)
  implicitHeight: isVertical ? indicator.implicitHeight + Style.space(8) : inheritedBarSize

  OverviewService {
    id: service
    helperPath: root.helperPath
    popoutOpen: popout.opened
  }

  StatusPopout {
    id: popout
    bar: root.bar
    anchorItem: root
    service: service
  }

  Grid {
    id: indicator
    anchors.centerIn: parent
    columns: root.isVertical ? 1 : 2
    spacing: Style.space(4)

    Text {
      text: root.statusIcon
      color: root.statusColor
      font.family: root.themeFont
      font.pixelSize: Style.font.body
      horizontalAlignment: Text.AlignHCenter
      Accessible.name: root.statusLabel
    }

    Text {
      visible: service.activeClaims > 0
      text: String(service.activeClaims)
      color: root.themeForeground
      font.family: root.themeFont
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      horizontalAlignment: Text.AlignHCenter
      Accessible.name: service.activeClaims + " active claims"
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onEntered: if (root.bar) root.bar.showTooltip(root, root.statusLabel)
    onExited: if (root.bar) root.bar.hideTooltip(root)
    onClicked: root.togglePanel()
  }
}
