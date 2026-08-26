import Testing

@testable import PimpampumMenuBar

@Suite
@MainActor
struct SettingsWindowOpenerTests {
  @Test
  func opensTheSettingsSceneAndActivatesTheAgentApplication() {
    var calls: [String] = []
    let opener = SettingsWindowOpener(
      showSettings: {
        calls.append("settings")
        return true
      },
      showPreferences: {
        calls.append("preferences")
        return true
      },
      activate: { calls.append("activate") }
    )

    opener.openSettings()

    #expect(calls == ["activate", "settings"])
  }

  @Test
  func activatesBeforeFallingBackToTheLegacyPreferencesSelector() {
    var calls: [String] = []
    let opener = SettingsWindowOpener(
      showSettings: {
        calls.append("settings")
        return false
      },
      showPreferences: {
        calls.append("preferences")
        return false
      },
      activate: { calls.append("activate") }
    )

    opener.openSettings()

    #expect(calls == ["activate", "settings", "preferences"])
  }
}
