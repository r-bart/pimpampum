import QtQuick
import qs.Commons

// The translucent fill behind an interactive row or action: invisible at rest, a light wash on
// hover, a stronger wash plus a hairline border while focused. It fills its parent and mirrors
// the focus and hover of the PimpampumActionArea it is given.
Rectangle {
  id: root

  required property color foreground
  required property var area

  anchors.fill: parent
  radius: Style.space(4)
  color: root.foreground
  opacity: root.area.activeFocus ? 0.13
    : root.area.containsMouse ? 0.07 : 0
  border.width: root.area.activeFocus ? 1 : 0
  border.color: root.foreground
}
