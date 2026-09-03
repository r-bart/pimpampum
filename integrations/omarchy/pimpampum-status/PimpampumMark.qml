import QtQuick
import QtQuick.Shapes

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
      "setup": "diamond",
      "credentials": "diamond",
      "invalid": "diamond",
      "incompatible": "diamond"
    }[status] || "diamond")
  readonly property color badgeColor: stale
    ? urgent
    : status === "active" ? activeColor
    : status === "available" ? availableColor
    : status === "complete" ? completeColor
    : ["offline", "setup", "credentials", "invalid", "incompatible"].indexOf(status) !== -1
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
      width: root.markSize + (badge.visible ? root.itemSpacing + root.badgeSize : 0)
      height: Math.max(root.markSize, root.badgeSize)
      Accessible.ignored: true

      // Drawn as a shape rather than a tinted image: MultiEffect samples the source
      // through a layer, and that texture kept its first color, so the mark stayed dark
      // when the bar recomputed its foreground against a new wallpaper. fillColor
      // repaints on every change, which is what PimpampumHeaderIcon already relies on.
      Item {
        id: markSource
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: root.markSize
        height: root.markSize

        Shape {
          width: 16
          height: 16
          transformOrigin: Item.TopLeft
          scale: root.markSize / 16
          preferredRendererType: Shape.CurveRenderer

          ShapePath {
            fillColor: root.foreground
            fillRule: ShapePath.OddEvenFill
            strokeColor: "transparent"
            strokeWidth: 0
            // Identical to branding/assets/pimpampum-compact-master.svg; the plugin
            // validator fails if the two ever drift apart.
            PathSvg {
              path: "M8 .5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 1 1 0-15zM4.8 3.9h1.4v.7c.7-.6 1.6-.9 2.6-.9 2 0 3.2 1.4 3.2 3.5 0 2-1.3 3.4-3.2 3.4-1 0-1.9-.3-2.6-.9v2.9H4.8V3.9zM6.3 7.2c0-1.3.9-2.2 2.2-2.2s2.1.9 2.1 2.2-.8 2.1-2.1 2.1-2.2-.8-2.2-2.1z"
            }
          }
        }
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
