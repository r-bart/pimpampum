import QtQuick
import QtQuick.Effects

Item {
  id: root

  required property string status
  required property string statusLabel
  required property bool stale
  required property bool vertical
  required property int activeClaims
  required property color foreground
  required property color urgent
  required property color activeColor
  required property color availableColor
  required property color completeColor
  required property string fontFamily
  property real markSize: 16
  property real badgeSize: 5
  property real itemSpacing: 4

  readonly property int safeActiveClaims: Math.max(0, activeClaims)
  readonly property string countLabel: safeActiveClaims >= 100 ? "99+" : String(safeActiveClaims)
  readonly property string claimLabel: safeActiveClaims === 0
    ? "No active claims"
    : safeActiveClaims === 1 ? "1 active claim" : safeActiveClaims + " active claims"
  readonly property string accessibleLabel: statusLabel + " · " + claimLabel
  readonly property string badgeKind: stale ? "ring" : ({
      "active": "dot",
      "available": "bar",
      "complete": "square",
      "draft": "ring",
      "empty": "bar",
      "offline": "diamond",
      "credentials": "diamond",
      "invalid": "diamond",
      "incompatible": "diamond"
    }[status] || "diamond")
  readonly property color badgeColor: stale
    ? urgent
    : status === "active" ? activeColor
    : status === "available" ? availableColor
    : status === "complete" ? completeColor
    : ["offline", "credentials", "invalid", "incompatible"].indexOf(status) !== -1
      ? urgent : foreground

  implicitWidth: indicator.implicitWidth
  implicitHeight: indicator.implicitHeight

  Grid {
    id: indicator
    anchors.centerIn: parent
    columns: root.vertical ? 1 : 2
    rows: root.vertical ? 2 : 1
    spacing: root.itemSpacing
    Accessible.ignored: true

    Item {
      id: identity
      width: root.markSize + root.itemSpacing + root.badgeSize
      height: Math.max(root.markSize, root.badgeSize)
      Accessible.ignored: true

      Image {
        id: markSource
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: root.markSize
        height: root.markSize
        source: Qt.resolvedUrl("assets/pimpampum-compact.svg")
        sourceSize.width: root.markSize
        sourceSize.height: root.markSize
        fillMode: Image.PreserveAspectFit
        smooth: true
        visible: false
      }

      MultiEffect {
        anchors.fill: markSource
        source: markSource
        autoPaddingEnabled: false
        colorization: 1
        colorizationColor: root.foreground
      }

      Item {
        id: badge
        anchors.left: markSource.right
        anchors.leftMargin: root.itemSpacing
        anchors.verticalCenter: parent.verticalCenter
        width: root.badgeSize
        height: root.badgeSize

        Rectangle {
          anchors.centerIn: parent
          width: root.badgeKind === "bar" ? root.badgeSize : root.badgeSize * 0.8
          height: root.badgeKind === "bar" ? Math.max(1, root.badgeSize * 0.32)
            : root.badgeSize * 0.8
          radius: root.badgeKind === "dot" ? width / 2
            : root.badgeKind === "bar" ? height / 2 : 1
          rotation: root.badgeKind === "diamond" ? 45 : 0
          color: root.badgeKind === "ring" ? "transparent" : root.badgeColor
          border.width: root.badgeKind === "ring" ? 1 : 0
          border.color: root.badgeColor
          opacity: root.status === "empty" && !root.stale ? 0.65 : 1
        }
      }
    }

    Text {
      visible: root.safeActiveClaims > 0
      text: root.countLabel
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Math.max(9, root.markSize * 0.72)
      font.bold: true
      horizontalAlignment: Text.AlignHCenter
      Accessible.ignored: true
    }
  }
}
