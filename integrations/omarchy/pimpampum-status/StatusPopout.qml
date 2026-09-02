import QtQuick
import qs.Commons
import qs.Ui

// The status popout: the popup card, its header and footer, and a Loader that shows one of
// PortfolioPage, SettingsPage or HelpPage. PopoutController owns every flag and action; the
// services arrive from BarWidget, which reads `opened` and calls open/close/toggle here.
Item {
  id: root

  required property var bar
  required property var anchorItem
  required property var service
  required property var backupService
  required property var syncService
  required property var serviceControl
  required property var updateService
  readonly property string connectionHelperPath: decodeURIComponent(
    Qt.resolvedUrl("pimpampum-connections").toString().replace(/^file:\/\//, "")
  )
  readonly property bool opened: popoutController.opened
  readonly property bool settingsView: popoutController.settingsView
  readonly property bool helpView: popoutController.helpView

  // The popout draws on the popup card Omarchy paints with Color.popups.background, not on
  // the wallpaper. bar.barForeground is resolved against whatever is behind a transparent
  // bar, and on a light wallpaper over a dark theme it equals the card's own background,
  // which rendered every label invisible. The popup tokens are what native panels use.
  readonly property color foreground: Color.popups.text
  readonly property color background: Color.popups.background
  readonly property color urgent: bar ? bar.urgent : "#ff5f57"
  readonly property color accent: Color.accent
  readonly property string fontFamily: bar ? bar.fontFamily : "monospace"

  function open() { popoutController.open() }
  function close() { popoutController.close() }
  function toggle() { popoutController.toggle() }
  function closeForPopoutSwitch() { popoutController.closeForPopoutSwitch() }

  AgentConnectionService {
    id: agentConnections
    helperPath: root.connectionHelperPath
  }

  PopoutController {
    id: popoutController
    service: root.service
    backupService: root.backupService
    syncService: root.syncService
    serviceControl: root.serviceControl
    updateService: root.updateService
    connectionService: agentConnections
    onScrollToTop: scroller.contentY = 0
  }

  Component {
    id: portfolioPage
    PortfolioPage {
      controller: popoutController
      service: root.service
      connectionService: agentConnections
      foreground: root.foreground
      background: root.background
      accent: root.accent
      urgent: root.urgent
      fontFamily: root.fontFamily
    }
  }

  Component {
    id: settingsPage
    SettingsPage {
      controller: popoutController
      connectionService: agentConnections
      backupService: root.backupService
      syncService: root.syncService
      serviceControl: root.serviceControl
      updateService: root.updateService
      foreground: root.foreground
      background: root.background
      accent: root.accent
      urgent: root.urgent
      fontFamily: root.fontFamily
    }
  }

  Component {
    id: helpPage
    HelpPage {
      foreground: root.foreground
      accent: root.accent
      fontFamily: root.fontFamily
    }
  }

  PopupCard {
    id: popup
    anchorItem: root.anchorItem
    bar: root.bar
    owner: root
    // A native folder dialog must be allowed to take focus without dismissing us.
    triggerMode: popoutController.folderDialogOpen ? "hover" : "click"
    // PopupCard maps this state to bar.requestPopout(owner) and
    // bar.releasePopout(owner), avoiding competing popup windows.
    open: root.opened
    contentWidth: fittedContentWidth(Style.space(380))
    contentHeight: fittedContentHeight(Math.min(content.implicitHeight + Style.space(53), Style.space(520)))

    Flickable {
      id: scroller
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.bottom: footerSeparator.top
      contentWidth: width
      contentHeight: content.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      Column {
        id: content
        width: parent.width
        spacing: Style.space(10)

        Item {
          width: parent.width
          height: Math.max(headerMark.implicitHeight, headerAction.height)

          PimpampumMark {
            id: headerMark
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            status: root.service.effectiveStatus
            statusLabel: root.service.stale ? "Stale" : root.service.connectionState
            stale: root.service.stale
            vertical: false
            activeClaims: root.service.activeClaims
            showActiveCount: false
            foreground: root.foreground
            urgent: root.urgent
            activeColor: "#3b82f6"
            availableColor: "#f59e0b"
            completeColor: "#22c55e"
            fontFamily: root.fontFamily
          }

          Column {
            id: headerCopy
            anchors.left: headerMark.right
            anchors.leftMargin: Style.space(10)
            anchors.right: headerAction.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(1)

            Text {
              text: root.helpView ? "Help" : root.settingsView ? "Settings" : "Pimpampum"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }

            Text {
              text: root.helpView ? "Portfolio, synchronization, and backup"
                : root.settingsView ? "Synchronization and backup"
                : root.service.stale ? "Stale" : root.service.connectionState
              color: root.service.connectionState === "online" ? root.foreground : root.urgent
              opacity: root.service.connectionState === "online" ? 0.72 : 1
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Item {
            id: headerAction
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(44)
            height: Style.space(44)

            HoverSurface {
              foreground: root.foreground
              area: headerActionArea
            }
            PimpampumHeaderIcon {
              anchors.centerIn: parent
              width: Style.space(24)
              height: Style.space(24)
              iconColor: root.foreground
              back: root.settingsView
            }
            PimpampumActionArea {
              id: headerActionArea
              anchors.fill: parent
              Accessible.name: root.helpView ? "Back to portfolio"
                : root.settingsView ? "Back to portfolio" : "Open settings"
              onTriggered: {
                if (root.helpView) popoutController.showSettings(false)
                else popoutController.showSettings(!root.settingsView)
              }
            }
          }
        }

        Rectangle {
          width: parent.width
          height: 1
          color: root.foreground
          opacity: 0.14
        }

        // One page at a time. The portfolio's disclosures and the settings confirmations keep
        // their state in the controller, so a page can be recreated on every switch.
        Loader {
          id: page
          width: parent.width
          sourceComponent: !root.settingsView ? portfolioPage
            : root.helpView ? helpPage : settingsPage
        }
      }
    }

    Rectangle {
      id: footerSeparator
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: footer.top
      height: 1
      color: root.foreground
      opacity: 0.14
    }

    Item {
      id: footer
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      height: Style.space(52)

      Item {
        id: footerHelpAction
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: footerHelpLabel.implicitWidth + Style.space(20)
        height: Style.space(44)

        HoverSurface {
          foreground: root.foreground
          area: footerHelpActionArea
        }

        Text {
          id: footerHelpLabel
          anchors.centerIn: parent
          text: "Help"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PimpampumActionArea {
          id: footerHelpActionArea
          anchors.fill: parent
          focusOnTab: parent.visible
          Accessible.name: "Open help"
          onTriggered: popoutController.openHelp()
        }
      }

      Item {
        id: quitAction
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        width: quitLabel.implicitWidth + Style.space(20)
        height: Style.space(44)

        HoverSurface {
          foreground: root.foreground
          area: quitActionArea
        }

        Text {
          id: quitLabel
          anchors.centerIn: parent
          text: root.serviceControl.running ? "Quit" : "Start"
          color: root.foreground
          opacity: root.serviceControl.busy ? 0.5 : 1
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PimpampumActionArea {
          id: quitActionArea
          anchors.fill: parent
          enabled: !root.serviceControl.busy
          focusOnTab: parent.visible && enabled
          Accessible.name: root.serviceControl.running ? "Quit Pimpampum" : "Start Pimpampum"
          onTriggered: {
            if (root.serviceControl.running) root.serviceControl.stop()
            else root.serviceControl.start()
          }
        }
      }
    }
  }
}
