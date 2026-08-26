import QtQuick

MouseArea {
  id: root

  property bool focusOnTab: true
  property bool triggerOnClick: true

  signal triggered()

  hoverEnabled: true
  activeFocusOnTab: focusOnTab
  cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
  Accessible.role: Accessible.Button
  Accessible.onPressAction: root.triggered()

  Keys.onPressed: function(event) {
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
        || event.key === Qt.Key_Space) {
      root.triggered()
      event.accepted = true
    }
  }

  onPressed: forceActiveFocus()
  onClicked: {
    if (root.triggerOnClick) root.triggered()
  }
}
