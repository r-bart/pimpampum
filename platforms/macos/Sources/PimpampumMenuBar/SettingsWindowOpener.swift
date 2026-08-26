@MainActor
protocol SettingsWindowOpening {
  func openSettings()
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
