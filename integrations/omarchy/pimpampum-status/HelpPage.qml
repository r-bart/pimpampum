import QtQuick
import qs.Commons

// The help view: how the portfolio reads, what synchronization and backup are for, the safe
// controls, updates, and conflict recovery. Loaded by StatusPopout behind the footer's Help.
Column {
  id: root

  required property color foreground
  required property color accent
  required property string fontFamily

  spacing: Style.space(10)

  PimpampumCard {
    width: parent.width
    foreground: root.foreground
    contentSpacing: Style.space(6)
    Text {
      text: "How Pimpampum works"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "Pimpampum is a local, agent-first project manager. Active work names the task being claimed now, followed by its project, Spec, agent, and remaining lease. Specs in progress remain visible even when no task is claimed and show completed versus total tasks. Completed Specs stay collapsed until you need the history. Project rows use the registered project and workspace names and open that workspace when selected."
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  PimpampumCard {
    width: parent.width
    foreground: root.foreground
    contentSpacing: Style.space(6)
    Text {
      text: "What is the difference?"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "Synchronization exchanges portfolio changes between your computers. Backup keeps a separate recovery copy of this computer’s local database."
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  PimpampumCard {
    width: parent.width
    foreground: root.foreground
    contentSpacing: Style.space(6)
    Text {
      text: "Why choose a shared folder?"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "Choose a location already managed by Dropbox, Syncthing, Drive, or a similar provider. Pimpampum creates a Pimpampum folder there and exchanges snapshots through it; Pimpampum does not upload files itself."
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  PimpampumCard {
    width: parent.width
    foreground: root.foreground
    contentSpacing: Style.space(6)
    Text {
      text: "Safe controls"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "Pause stops synchronization temporarily. Forget disconnects this computer without deleting shared snapshots or local data. Disabling backup stops new copies without deleting the existing backup file."
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  PimpampumCard {
    width: parent.width
    foreground: root.foreground
    contentSpacing: Style.space(6)
    Text {
      text: "Updates"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "Run pimpampum update:check to check for a release, then pimpampum update to install it. Your local data is preserved."
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  PimpampumCard {
    width: parent.width
    foreground: root.foreground
    contentSpacing: Style.space(6)
    Text {
      text: "Conflicts and recovery"
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "Inspect both candidates before resolving a conflict:"
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "pimpampum sync conflicts"
      color: root.accent
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "The recovery file is named pimpampum-latest.sqlite in your chosen backup destination."
      color: root.foreground
      opacity: 0.72
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }
}
