import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
@MainActor
struct BackupDirectoryPickerTests {
  @Test
  func pickerForwardsTheInitialDirectoryAndStandardizesTheSelection() {
    var received: URL?
    let picker = BackupDirectoryPicker { initial in
      received = initial
      return URL(fileURLWithPath: "/tmp/Backup/../Backup", isDirectory: true)
    }
    let initial = URL(fileURLWithPath: "/tmp", isDirectory: true)

    #expect(picker.chooseDirectory(initialDirectory: initial)?.path == "/tmp/Backup")
    #expect(received == initial)

    let cancelled = BackupDirectoryPicker { _ in nil }
    #expect(cancelled.chooseDirectory(initialDirectory: nil) == nil)
  }

  @Test
  func openerValidatesAndOpensOnlyAnAbsoluteDirectory() throws {
    var validated: [String] = []
    var opened: [URL] = []
    let opener = BackupDirectoryOpener(
      validateDirectory: {
        validated.append($0)
        return true
      },
      openDirectory: {
        opened.append($0)
        return true
      }
    )

    try opener.openDirectory(at: "/tmp/Backup/../Backup")
    #expect(validated == ["/tmp/Backup"])
    #expect(opened.map(\.path) == ["/tmp/Backup"])
  }

  @Test(arguments: ["", "relative", "/safe\0unsafe"])
  func openerRejectsInvalidPaths(path: String) {
    let opener = BackupDirectoryOpener(validateDirectory: { _ in true }, openDirectory: { _ in true })
    #expect(throws: BackupDirectoryOpenError.invalidPath) {
      try opener.openDirectory(at: path)
    }
  }

  @Test
  func openerReportsUnavailableAndFinderFailures() {
    let missing = BackupDirectoryOpener(validateDirectory: { _ in false }, openDirectory: { _ in true })
    #expect(throws: BackupDirectoryOpenError.unavailable(path: "/missing")) {
      try missing.openDirectory(at: "/missing")
    }

    let refused = BackupDirectoryOpener(validateDirectory: { _ in true }, openDirectory: { _ in false })
    #expect(throws: BackupDirectoryOpenError.openFailed(path: "/refused")) {
      try refused.openDirectory(at: "/refused")
    }
  }

  @Test
  func productionValidatorDistinguishesDirectoriesFromFiles() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pimpampum-backup-opener-\(UUID().uuidString)", isDirectory: true)
    let file = root.appendingPathComponent("file")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data("content".utf8).write(to: file)
    defer { try? FileManager.default.removeItem(at: root) }

    var opened: [URL] = []
    let opener = BackupDirectoryOpener(fileManager: .default) {
      opened.append($0)
      return true
    }
    try opener.openDirectory(at: root.path)
    #expect(opened == [root.standardizedFileURL])
    #expect(throws: BackupDirectoryOpenError.unavailable(path: file.path)) {
      try opener.openDirectory(at: file.path)
    }
  }

  @Test
  func everyOpenErrorHasAnActionableDescription() {
    let errors: [BackupDirectoryOpenError] = [
      .invalidPath, .unavailable(path: "/missing"), .openFailed(path: "/refused"),
    ]
    #expect(errors.allSatisfy { !($0.errorDescription ?? "").isEmpty })
  }

  @Test
  func settingsViewAcceptsInjectedNativeBoundaries() {
    let store = BackupSettingsStore(client: SequenceStaticBackupReader())
    let view = BackupSettingsView(
      store: store,
      directoryPicker: BackupDirectoryPicker { _ in nil },
      directoryOpener: BackupDirectoryOpener(
        validateDirectory: { _ in true }, openDirectory: { _ in true })
    )
    _ = view.body
  }

  @Test(arguments: BackupHealthState.allCases)
  func settingsViewComposesEveryBackupHealthState(state: BackupHealthState) async {
    let store = BackupSettingsStore(client: SequenceStaticBackupReader(state: state))
    await store.load()
    let view = BackupSettingsView(
      store: store,
      directoryPicker: BackupDirectoryPicker { _ in nil },
      directoryOpener: BackupDirectoryOpener(
        validateDirectory: { _ in true }, openDirectory: { _ in true })
    )
    _ = view.body
  }

  @Test
  func settingsViewUsesTheApprovedWindowMetricsPathTreatmentAndEnglishCopy() {
    #expect(BackupSettingsView.contentWidth == 460)
    #expect(BackupSettingsView.contentHeight == 270)
    #expect(BackupSettingsView.configuredPathLineLimit == 2)
    #expect(BackupSettingsCopy.title == "Backup")
    #expect(
      BackupSettingsCopy.description
        == "Keep one current snapshot after every change. The live database stays local.")
    #expect(BackupSettingsCopy.refresh == "Refresh backup status")
    #expect(BackupSettingsCopy.loading == "Loading backup settings…")
    #expect(BackupSettingsCopy.disabled == "Automatic backup is off")
    #expect(BackupSettingsCopy.folder == "Folder")
    #expect(BackupSettingsCopy.chooseFolder == "Choose Folder…")
    #expect(BackupSettingsCopy.change == "Change…")
    #expect(BackupSettingsCopy.openInFinder == "Open in Finder")
    #expect(BackupSettingsCopy.backUpNow == "Back Up Now")
    #expect(BackupSettingsCopy.tryAgain == "Try Again")
    #expect(BackupSettingsCopy.disable == "Disable")
  }

  @Test
  func settingsPresentationCoversLoadingDisabledConfiguredAndInstallationErrors() {
    #expect(
      presentation(settings: nil, activity: .loading)
        == BackupSettingsViewPresentation(
          variant: .loading,
          controlsDisabled: true,
          refreshDisabled: true,
          primaryActionTitle: "Back Up Now",
          inlineError: nil
        ))
    #expect(
      presentation(settings: backupSettings(.disabled))
        == BackupSettingsViewPresentation(
          variant: .disabled,
          controlsDisabled: false,
          refreshDisabled: false,
          primaryActionTitle: "Back Up Now",
          inlineError: nil
        ))
    #expect(
      presentation(settings: backupSettings(.healthy))
        == BackupSettingsViewPresentation(
          variant: .configured(.healthy),
          controlsDisabled: false,
          refreshDisabled: false,
          primaryActionTitle: "Back Up Now",
          inlineError: nil
        ))
    #expect(
      presentation(settings: backupSettings(.error))
        == BackupSettingsViewPresentation(
          variant: .configured(.error),
          controlsDisabled: false,
          refreshDisabled: false,
          primaryActionTitle: "Try Again",
          inlineError: nil
        ))

    let installationError =
      "pim • pam • pum's installation receipt could not be read. Run pimpampum install."
    #expect(
      presentation(settings: nil, operationError: installationError)
        == BackupSettingsViewPresentation(
          variant: .installationError,
          controlsDisabled: true,
          refreshDisabled: false,
          primaryActionTitle: "Back Up Now",
          inlineError: installationError
        ))
  }

  @Test
  func unreadableSettingsShowTheDaemonsReasonAndOfferTheFolderThatRepairsThem() async {
    // M-C6: `enabled: false, state: .error` used to fall into the plain "off" variant and hide the
    // message. The covered model names it; the view shows it under "Backup needs attention".
    let message = "Backup settings file is corrupt; choose a folder to write it again."
    let unreadable = BackupSettings(
      enabled: false, directory: nil, snapshotPath: nil, state: .error,
      lastAttemptAt: nil, lastSuccessAt: nil, error: message)
    #expect(unreadable.unreadableSettingsMessage == message)
    #expect(backupSettings(.disabled).unreadableSettingsMessage == nil)
    #expect(backupSettings(.error).unreadableSettingsMessage == nil)
    #expect(BackupHealthState.error.label == "Backup needs attention")
    #expect(
      presentation(settings: unreadable)
        == BackupSettingsViewPresentation(
          variant: .needsAttention(message),
          controlsDisabled: false,
          refreshDisabled: false,
          primaryActionTitle: "Back Up Now",
          inlineError: nil
        ))
    let store = BackupSettingsStore(client: SequenceStaticBackupReader(settings: unreadable))
    await store.load()
    #expect(store.settings == unreadable)
    let view = BackupSettingsView(
      store: store,
      directoryPicker: BackupDirectoryPicker { _ in nil },
      directoryOpener: BackupDirectoryOpener(
        validateDirectory: { _ in true }, openDirectory: { _ in true })
    )
    _ = view.body
  }

  @Test
  func pendingAndEveryInFlightOperationDisableAllCompetingControls() {
    #expect(
      presentation(settings: backupSettings(.pending))
        == BackupSettingsViewPresentation(
          variant: .configured(.pending),
          controlsDisabled: true,
          refreshDisabled: true,
          primaryActionTitle: "Back Up Now",
          inlineError: nil
        ))

    for activity in [
      BackupSettingsActivity.loading,
      .configuring,
      .retrying,
      .disabling,
    ] {
      let state = presentation(settings: backupSettings(.healthy), activity: activity)
      #expect(state.variant == .configured(.pending))
      #expect(state.controlsDisabled)
      #expect(state.refreshDisabled)
      #expect(state.primaryActionTitle == "Back Up Now")
    }

    let chosenPath = "/Users/pim/Library/CloudStorage/Dropbox/Pimpampum snapshots"
    let choosing = presentation(
      settings: backupSettings(.disabled),
      pendingDirectory: chosenPath
    )
    #expect(choosing.variant == .configured(.pending))
    #expect(choosing.controlsDisabled)
    #expect(choosing.refreshDisabled)
  }

  @Test
  func inlineFinderAndOperationErrorsRemainActionableWithoutBlockingKnownState() {
    let finderError = "Finder could not open the backup directory: /Volumes/Backup"
    let finderState = presentation(
      settings: backupSettings(.healthy),
      finderError: finderError
    )
    #expect(finderState.inlineError == finderError)
    #expect(!finderState.controlsDisabled)
    #expect(!finderState.refreshDisabled)

    let operationError = "Choose another folder."
    let operationState = presentation(
      settings: backupSettings(.disabled),
      operationError: operationError,
      finderError: finderError
    )
    #expect(operationState.variant == .disabled)
    #expect(operationState.inlineError == operationError)
    #expect(!operationState.controlsDisabled)
    #expect(!operationState.refreshDisabled)
  }

  private func presentation(
    settings: BackupSettings?,
    activity: BackupSettingsActivity = .idle,
    pendingDirectory: String? = nil,
    operationError: String? = nil,
    finderError: String? = nil
  ) -> BackupSettingsViewPresentation {
    BackupSettingsView.presentation(
      settings: settings,
      activity: activity,
      pendingDirectory: pendingDirectory,
      operationError: operationError,
      finderError: finderError
    )
  }

  private func backupSettings(_ state: BackupHealthState) -> BackupSettings {
    BackupSettings(
      enabled: state != .disabled,
      directory: state == .disabled ? nil : "/tmp/Backup",
      snapshotPath: state == .disabled ? nil : "/tmp/Backup/pimpampum-latest.sqlite",
      state: state,
      lastAttemptAt: nil,
      lastSuccessAt: state == .healthy ? Date(timeIntervalSince1970: 1) : nil,
      error: state == .error ? "The destination volume is full. Free space or choose another folder." : nil
    )
  }
}

private struct SequenceStaticBackupReader: BackupSettingsReading {
  let state: BackupHealthState
  let settings: BackupSettings?

  init(state: BackupHealthState = .disabled) {
    self.state = state
    self.settings = nil
  }

  /// One exact answer, for shapes the state alone cannot describe.
  init(settings: BackupSettings) {
    self.state = settings.state
    self.settings = settings
  }

  func fetchBackupSettings() async throws -> BackupSettings { value }
  func configureBackup(directory _: String) async throws -> BackupSettings { value }
  func retryBackup() async throws -> BackupSettings { value }
  func disableBackup() async throws -> BackupSettings { value }

  private var value: BackupSettings {
    if let settings { return settings }
    return BackupSettings(
      enabled: state != .disabled,
      directory: state == .disabled ? nil : "/tmp/Backup",
      snapshotPath: state == .disabled ? nil : "/tmp/Backup/pimpampum-latest.sqlite",
      state: state,
      lastAttemptAt: nil,
      lastSuccessAt: nil,
      error: state == .error ? "Unavailable" : nil
    )
  }
}
