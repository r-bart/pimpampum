import QtQuick

Item {
  id: root

  required property string status
  required property string statusLabel
  required property bool stale
  required property bool vertical
  required property int activeClaims
  required property color foreground
  required property color contrastBackground
  required property color urgent
  required property color activeColor
  required property color availableColor
  required property color completeColor
  required property string fontFamily
  property real markSize: 16
  property real badgeSize: 5
  property real itemSpacing: 4
  property bool showActiveCount: true

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
      "cancelled": "ring",
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
  readonly property bool useLightAsset:
    (contrastBackground.r * 0.2126 + contrastBackground.g * 0.7152
      + contrastBackground.b * 0.0722) < 0.5

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
      width: root.markSize + (badge.visible ? root.itemSpacing + root.badgeSize : 0)
      height: Math.max(root.markSize, root.badgeSize)
      Accessible.ignored: true

      Image {
        id: markSource
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: root.markSize
        height: root.markSize
        source: Qt.resolvedUrl(root.useLightAsset
          ? "assets/pimpampum-compact-white.svg"
          : "assets/pimpampum-compact.svg")
        sourceSize.width: root.markSize
        sourceSize.height: root.markSize
        fillMode: Image.PreserveAspectFit
        smooth: true
      }

      Item {
        id: badge
        visible: !root.showActiveCount || root.safeActiveClaims === 0
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
      visible: root.showActiveCount && root.safeActiveClaims > 0
      text: root.countLabel
      color: root.activeColor
      font.family: root.fontFamily
      font.pixelSize: Math.max(9, root.markSize * 0.72)
      font.bold: true
      horizontalAlignment: Text.AlignHCenter
      Accessible.ignored: true
    }
  }
}
