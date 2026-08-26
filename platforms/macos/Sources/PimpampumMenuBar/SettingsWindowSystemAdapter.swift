import AppKit

extension SettingsWindowOpener {
  init(application: NSApplication = .shared) {
    self.init(
      showSettings: {
        application.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
      },
      showPreferences: {
        application.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
      },
      activate: {
        application.activate(ignoringOtherApps: true)
      }
    )
  }
}
