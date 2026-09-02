import AppKit
import SwiftUI
import Testing

@testable import PimpampumMenuBar

@Suite
@MainActor
struct HelpDialogTests {
  @Test
  func usesTheApprovedCompactEnglishCopy() {
    #expect(HelpDialogCopy.buttonTitle == "How it works")
    #expect(HelpDialogCopy.title == "How pim • pam • pum works")
    #expect(HelpDialogCopy.introduction == "pim • pam • pum is a local, agent-first project manager.")
    #expect(HelpDialogCopy.done == "Done")
    #expect(
      HelpDialogCopy.items.map(\.text) == [
        "pim • pam • pum runs locally on this machine.",
        "Projects contain Specs; Specs may contain tasks and optional subtasks.",
        "Agents interact through MCP, the CLI, or the local API.",
        "Claimed work appears under Active work and in the menu-bar count.",
        "Clicking a project opens its workspace in Finder.",
        "Synchronization shares portfolio changes through a folder managed by your sync provider.",
        "Backup keeps a separate recovery copy; it does not synchronize other computers.",
        "Check and install releases from Settings > Updates without deleting local data. The same actions are available as pimpampum update:check and pimpampum update.",
      ])
    #expect(Set(HelpDialogCopy.items.map(\.id)).count == HelpDialogCopy.items.count)
    #expect(HelpDialogCopy.items.allSatisfy { !$0.systemImage.isEmpty })
  }

  @Test
  func composesTheNativeDialog() {
    _ = HelpDialog(onDone: {}).body
  }

  @Test
  func fitsInsideThePopoverWidth() {
    // The dialog was 440 pt wide inside a 360 pt popover, a leftover from the sheet era, so its
    // sides were clipped. It now takes the width it is given.
    let controller = NSHostingController(rootView: HelpDialog(onDone: {}))
    let size = controller.sizeThatFits(
      in: NSSize(width: StatusPopover.containerWidth, height: 0))
    #expect(size.width <= StatusPopover.containerWidth)
    #expect(size.width > 0)
    #expect(size.height > 200)
  }

  @Test
  func doneClosesOnlyTheDialog() {
    // The dialog used `@Environment(\.dismiss)`, which inside a menu-bar popover closed the whole
    // popover. Dismissal is now a callback the presenting view owns.
    var closed = 0
    let dialog = HelpDialog(onDone: { closed += 1 })
    dialog.onDone()
    #expect(closed == 1)
  }
}
