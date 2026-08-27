import QtQuick
import qs.Commons

Item {
  id: root

  property string label: ""
  property bool primary: false
  property bool destructive: false
  property bool compact: false
  property bool actionEnabled: true
  property color foreground: "white"
  property color background: "#202020"
  property color accent: Color.accent
  property color urgent: "#ff5f57"
  property string fontFamily: "monospace"
  property int minimumWidth: compact ? Style.space(44) : Style.space(88)

  signal triggered()

  readonly property color actionColor: destructive ? urgent
    : primary ? Style.selectedStateColor(foreground, accent, urgent) : foreground
  implicitWidth: Math.max(minimumWidth, buttonLabel.implicitWidth + Style.space(primary ? 24 : 20))
  implicitHeight: Style.space(44)

  Rectangle {
    anchors.fill: parent
    radius: Style.space(4)
    color: root.primary
      ? buttonArea.pressed ? Style.pressedFillFor(root.foreground, root.accent, root.urgent)
        : buttonArea.activeFocus ? Style.focusFillFor(root.foreground, root.accent, root.urgent)
        : buttonArea.containsMouse ? Style.hoverFillFor(root.foreground, root.accent, root.urgent)
        : Style.selectedFillFor(root.foreground, root.accent, root.urgent)
      : Qt.rgba(root.actionColor.r, root.actionColor.g, root.actionColor.b,
          buttonArea.activeFocus ? 0.16 : buttonArea.containsMouse ? 0.11 : 0.04)
    border.width: buttonArea.activeFocus ? 2 : 1
    border.color: buttonArea.activeFocus
      ? Style.focusBorderFor(root.foreground, root.accent, root.urgent)
      : root.primary ? Style.selectedBorderFor(root.foreground, root.accent, root.urgent)
      : Qt.rgba(root.actionColor.r, root.actionColor.g, root.actionColor.b,
          root.destructive ? 0.5 : 0.22)

    Text {
      id: buttonLabel
      anchors.centerIn: parent
      text: root.label
      color: root.actionColor
      opacity: root.actionEnabled ? 1 : 0.5
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: root.primary
    }
  }

  PimpampumActionArea {
    id: buttonArea
    anchors.fill: parent
    enabled: root.actionEnabled
    focusOnTab: root.visible && enabled
    Accessible.name: root.label
    onTriggered: root.triggered()
  }
}
