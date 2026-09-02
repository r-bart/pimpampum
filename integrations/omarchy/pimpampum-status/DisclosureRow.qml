import QtQuick
import qs.Commons

// The collapsible section header of the portfolio: a bold title behind a ▸/▾ marker, toggled by
// click, keyboard or the accessibility press action.
Item {
  id: root

  required property color foreground
  required property string fontFamily
  required property string title
  required property bool expanded

  signal toggled()

  height: disclosureTitle.implicitHeight + Style.space(8)

  HoverSurface {
    foreground: root.foreground
    area: disclosureAction
  }

  Text {
    id: disclosureTitle
    anchors.verticalCenter: parent.verticalCenter
    text: (root.expanded ? "▾ " : "▸ ") + root.title
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    font.bold: true
  }

  PimpampumActionArea {
    id: disclosureAction
    anchors.fill: parent
    focusOnTab: root.visible
    Accessible.name: disclosureTitle.text
    Accessible.description: root.expanded ? "Expanded" : "Collapsed"
    onTriggered: root.toggled()
  }
}
