import QtQuick
import qs.Commons

// The settings card shared by synchronization and backup: a title with its state, a description,
// the configured folder with Open and Manage, the manage panel (change location or forget), an
// optional slot for card-specific detail rows, the error line, one confirmation line and the
// secondary/primary action row. Every word and flag comes from the page; the card only lays out.
PimpampumCard {
  id: root

  required property color background
  required property color accent
  required property color urgent
  required property string fontFamily
  required property string title
  required property string description
  required property string stateText
  required property color stateColor
  required property real stateOpacity
  // The service has a folder (`enabled` on the service; named apart from Item.enabled here).
  required property bool configured
  required property bool busy
  required property string directory
  required property bool manageOpen
  // A confirmation is pending: the folder row and the manage panel step aside for it.
  required property bool confirming
  required property bool folderDialogAvailable
  required property string changeLabel
  required property string removeLabel
  required property string errorText
  required property string confirmationText
  required property bool confirmationUrgent
  required property bool secondaryVisible
  required property string secondaryLabel
  required property string primaryLabel
  required property bool primaryDestructive
  required property bool primaryEnabled
  // Shown between the folder row and the manage panel while no folder is configured.
  property string emptyText: ""
  // Card-specific rows placed after the manage panel and before the error line.
  property alias details: detailsSlot.data

  signal openRequested()
  signal manageToggled()
  signal changeRequested()
  signal removeRequested()
  signal secondaryTriggered()
  signal primaryTriggered()

  Row {
    width: parent.width
    spacing: Style.space(8)
    Text {
      width: parent.width - stateLabel.width - parent.spacing
      text: root.title
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }
    Text {
      id: stateLabel
      text: "● " + root.stateText
      color: root.stateColor
      opacity: root.stateOpacity
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  Text {
    width: parent.width
    wrapMode: Text.Wrap
    text: root.description
    color: root.foreground
    opacity: 0.72
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  Row {
    visible: root.configured && !root.confirming
    width: parent.width
    spacing: Style.space(6)
    Text {
      width: Math.max(0, parent.width - openButton.width
        - manageButton.width - parent.spacing * 2)
      anchors.verticalCenter: parent.verticalCenter
      elide: Text.ElideMiddle
      text: root.directory
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    PimpampumSettingsButton {
      id: openButton
      width: implicitWidth
      height: implicitHeight
      label: "Open"
      compact: true
      minimumWidth: Style.space(48)
      foreground: root.foreground; background: root.background
      accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
      actionEnabled: !root.busy
      onTriggered: root.openRequested()
    }
    PimpampumSettingsButton {
      id: manageButton
      width: implicitWidth
      height: implicitHeight
      label: root.manageOpen ? "Close" : "Manage"
      compact: true
      minimumWidth: Style.space(64)
      foreground: root.foreground; background: root.background
      accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
      onTriggered: root.manageToggled()
    }
  }

  Text {
    visible: root.emptyText !== "" && !root.configured && !root.confirming
    width: parent.width
    text: root.emptyText
    color: root.foreground
    opacity: 0.55
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  Rectangle {
    visible: root.manageOpen && root.configured && !root.confirming
    width: parent.width
    height: manageActions.implicitHeight + Style.space(16)
    radius: Style.space(4)
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
    border.width: 1
    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.1)
    Row {
      id: manageActions
      anchors.centerIn: parent
      spacing: Style.space(6)
      PimpampumSettingsButton {
        width: implicitWidth; height: implicitHeight
        label: root.changeLabel
        foreground: root.foreground; background: root.background
        accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
        actionEnabled: root.folderDialogAvailable && !root.busy
        onTriggered: root.changeRequested()
      }
      PimpampumSettingsButton {
        width: implicitWidth; height: implicitHeight
        label: root.removeLabel
        destructive: true
        foreground: root.foreground; background: root.background
        accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
        actionEnabled: !root.busy
        onTriggered: root.removeRequested()
      }
    }
  }

  // An empty slot must not cost a row of spacing, so it hides itself while nothing in it shows.
  Column {
    id: detailsSlot
    width: parent.width
    spacing: parent.spacing
    visible: visibleChildren.length > 0
  }

  Text {
    visible: root.errorText !== ""
    width: parent.width
    wrapMode: Text.Wrap
    text: root.errorText
    color: root.urgent
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  Text {
    visible: root.confirmationText !== ""
    width: parent.width
    wrapMode: Text.Wrap
    text: root.confirmationText
    color: root.confirmationUrgent ? root.urgent : root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  Row {
    width: parent.width
    spacing: Style.space(6)
    PimpampumSettingsButton {
      id: secondaryAction
      visible: root.secondaryVisible
      width: visible ? implicitWidth : 0
      height: implicitHeight
      label: root.secondaryLabel
      foreground: root.foreground; background: root.background
      accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
      actionEnabled: !root.busy
      onTriggered: root.secondaryTriggered()
    }
    PimpampumSettingsButton {
      id: primaryAction
      width: Math.max(implicitWidth, parent.width - secondaryAction.width
        - (secondaryAction.visible ? parent.spacing : 0))
      height: implicitHeight
      primary: !root.primaryDestructive
      destructive: root.primaryDestructive
      label: root.primaryLabel
      foreground: root.foreground; background: root.background
      accent: root.accent; urgent: root.urgent; fontFamily: root.fontFamily
      actionEnabled: root.primaryEnabled
      onTriggered: root.primaryTriggered()
    }
  }
}
