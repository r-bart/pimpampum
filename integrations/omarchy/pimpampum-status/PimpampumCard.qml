import QtQuick
import qs.Commons

// The framed card of the settings and help pages: a faint foreground tint behind a hairline
// border, content inset by the card margin. Declared children land in the inner column.
Rectangle {
  id: root

  required property color foreground
  property real contentSpacing: Style.space(8)
  default property alias content: cardContent.data

  height: cardContent.implicitHeight + Style.space(28)
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
    spacing: root.contentSpacing
  }
}
