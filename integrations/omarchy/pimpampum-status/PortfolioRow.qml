import QtQuick
import qs.Commons

// One selectable row of the portfolio: a title, an optional second line, and the hover, focus,
// keyboard and accessibility treatment every row shares. Activating it opens the row's workspace.
Item {
  id: root

  required property color foreground
  required property string fontFamily
  required property string title
  required property string accessibleName
  property string subtitle: ""
  property real titleOpacity: 1
  property real verticalPadding: Style.space(10)

  signal activated()

  height: rowText.implicitHeight + root.verticalPadding

  HoverSurface {
    foreground: root.foreground
    area: rowAction
  }

  Column {
    id: rowText
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(1)

    Text {
      width: parent.width
      elide: Text.ElideRight
      text: root.title
      color: root.foreground
      opacity: root.titleOpacity
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      visible: root.subtitle !== ""
      width: parent.width
      elide: Text.ElideRight
      text: root.subtitle
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  PimpampumActionArea {
    id: rowAction
    anchors.fill: parent
    Accessible.name: root.accessibleName
    onTriggered: root.activated()
  }
}
