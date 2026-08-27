@MainActor
protocol SettingsWindowOpening {
  func openSettings()
}

@MainActor
struct PopoverDismissingSettingsWindowOpener: SettingsWindowOpening {
  private let settingsWindowOpener: any SettingsWindowOpening
  private let dismissPopover: () -> Void

  init(
    settingsWindowOpener: any SettingsWindowOpening,
    dismissPopover: @escaping () -> Void
  ) {
    self.settingsWindowOpener = settingsWindowOpener
    self.dismissPopover = dismissPopover
  }

  func openSettings() {
    dismissPopover()
    settingsWindowOpener.openSettings()
  }
}

@MainActor
struct SettingsWindowOpener: SettingsWindowOpening {
  private let showSettings: () -> Bool
  private let showPreferences: () -> Bool
  private let activate: () -> Void

  init(
    showSettings: @escaping () -> Bool,
    showPreferences: @escaping () -> Bool,
    activate: @escaping () -> Void
  ) {
    self.showSettings = showSettings
    self.showPreferences = showPreferences
    self.activate = activate
  }

  func openSettings() {
    activate()
    if !showSettings() {
      _ = showPreferences()
    }
  }
}
