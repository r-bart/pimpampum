import Testing

@testable import PimpampumMenuBar

/// `StateVocabulary.swift` is generated from the table in `scripts/generate-state-vocabulary.mjs`,
/// the same table that renders the Omarchy plugin's labels. These are frozen copy: a rename has to
/// be a deliberate edit of the table, never a silent change of what one surface says.
@Suite
struct StateVocabularyTests {
  @Test
  func overviewStatusesAreTheDaemonsPortfolioStates() {
    #expect(
      OverviewStatus.allCases.map(\.rawValue) == [
        "active", "available", "complete", "draft", "paused", "empty",
      ])
  }

  @Test
  func everyAgentConnectionStateNamesItself() {
    #expect(
      SetupComponentState.allCases.map(\.label) == [
        "Not installed",
        "Not connected",
        "Connecting",
        "Connected",
        "New session required",
        "Needs repair",
        "Configuration conflict",
        "Unsupported version",
        "Unavailable",
      ])
    #expect(SetupComponentState(rawValue: "newSessionRequired") == .newSessionRequired)
  }

  @Test
  func everySyncHealthStateNamesItself() {
    #expect(
      SyncHealthState.allCases.map(\.label) == [
        "Not configured",
        "Synchronization paused",
        "Changes pending",
        "Importing changes…",
        "Exporting changes…",
        "Up to date",
        "Shared folder unavailable",
        "Synchronization needs attention",
        "Conflict requires attention",
      ])
  }

  @Test
  func everyBackupHealthStateNamesItself() {
    #expect(
      BackupHealthState.allCases.map(\.label) == [
        "Automatic backup is off", "Backing up…", "Up to date", "Backup needs attention",
      ])
  }
}
