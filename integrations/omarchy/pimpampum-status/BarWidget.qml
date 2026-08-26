import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "dev.pimpampum.status"

  readonly property string helperPath: decodeURIComponent(
    Qt.resolvedUrl("pimpampum-overview").toString().replace(/^file:\/\//, "")
  )
  readonly property string backupHelperPath: decodeURIComponent(
    Qt.resolvedUrl("pimpampum-backup").toString().replace(/^file:\/\//, "")
  )
  readonly property bool isVertical: bar ? bar.vertical : false
  readonly property color themeForeground: bar ? bar.foreground : "white"
  readonly property color themeBackground: bar ? bar.background : "#202020"
  readonly property color themeUrgent: bar ? bar.urgent : "#ff5f57"
  readonly property color activeBlue: "#3b82f6"
  readonly property color availableAmber: "#f59e0b"
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
  readonly property real markSize: Math.max(14, Math.min(16, inheritedBarSize - Style.space(8)))

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

  BackupService {
    id: backupService
    helperPath: root.backupHelperPath
    popoutOpen: popout.opened
  }

  StatusPopout {
    id: popout
    bar: root.bar
    anchorItem: root
    service: service
    backupService: backupService
  }

  PimpampumMark {
    id: indicator
    anchors.centerIn: parent
    status: service.effectiveStatus
    statusLabel: root.statusLabel
    stale: service.stale
    vertical: root.isVertical
    activeClaims: service.activeClaims
    foreground: root.themeForeground
    urgent: root.themeUrgent
    activeColor: root.activeBlue
    availableColor: root.availableAmber
    completeColor: root.completedGreen
    fontFamily: root.themeFont
    markSize: root.markSize
    badgeSize: Style.space(5)
    itemSpacing: Style.space(4)
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    Accessible.role: Accessible.Button
    Accessible.name: indicator.accessibleLabel
    Accessible.onPressAction: root.togglePanel()
    onEntered: if (root.bar) root.bar.showTooltip(root, root.statusLabel)
    onExited: if (root.bar) root.bar.hideTooltip(root)
    onClicked: root.togglePanel()
  }
}
