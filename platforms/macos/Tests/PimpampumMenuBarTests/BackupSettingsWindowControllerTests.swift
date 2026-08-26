import AppKit
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
@MainActor
struct BackupSettingsWindowControllerTests {
  @Test
  func createsShowsAndReusesAConcreteSettingsWindow() {
    let store = BackupSettingsStore(client: WindowStaticBackupReader())
    let presenter = BackupSettingsWindowController(store: store)

    presenter.openSettings()
    let first = presenter.windowController
    #expect(first?.window?.title == "Pimpampum Settings")
    #expect(first?.window?.isVisible == true)
    #expect(NSApplication.shared.orderedWindows.first === first?.window)
    #expect(first?.window?.contentLayoutRect.size.width == 460)
    #expect(first?.window?.contentLayoutRect.size.height == 270)
    #expect(first?.window?.contentMinSize == NSSize(width: 460, height: 270))
    #expect(first?.window?.contentMaxSize.width == 460)
    #expect(first?.window?.styleMask.contains(.titled) == true)
    #expect(first?.window?.isReleasedWhenClosed == false)

    presenter.openSettings()
    #expect(presenter.windowController === first)
    #expect(presenter.windowController?.window?.isVisible == true)
    #expect(NSApplication.shared.orderedWindows.first === first?.window)

    first?.close()
    #expect(first?.window?.isVisible == false)

    presenter.openSettings()
    #expect(presenter.windowController === first)
    #expect(first?.window?.isVisible == true)
    #expect(NSApplication.shared.orderedWindows.first === first?.window)

    first?.close()
  }

  @Test
  func refreshesDaemonStateEveryTimeTheRetainedWindowOpens() async {
    let initial = BackupSettings(
      enabled: false,
      directory: nil,
      snapshotPath: nil,
      state: .disabled,
      lastAttemptAt: nil,
      lastSuccessAt: nil,
      error: nil
    )
    let changed = BackupSettings(
      enabled: true,
      directory: "/tmp/Backups",
      snapshotPath: "/tmp/Backups/pimpampum-latest.sqlite",
      state: .healthy,
      lastAttemptAt: nil,
      lastSuccessAt: nil,
      error: nil
    )
    let reader = WindowSequenceBackupReader([initial, changed])
    let store = BackupSettingsStore(client: reader)
    let presenter = BackupSettingsWindowController(store: store)

    presenter.openSettings()
    await presenter.refreshTask?.value
    #expect(store.settings == initial)
    presenter.windowController?.close()

    presenter.openSettings()
    await presenter.refreshTask?.value
    #expect(store.settings == changed)
    #expect(await reader.fetchCount == 2)

    presenter.windowController?.close()
  }
}

private actor WindowSequenceBackupReader: BackupSettingsReading {
  private var values: [BackupSettings]
  private(set) var fetchCount = 0

  init(_ values: [BackupSettings]) { self.values = values }

  func fetchBackupSettings() async throws -> BackupSettings {
    fetchCount += 1
    return values.removeFirst()
  }

  func configureBackup(directory _: String) async throws -> BackupSettings { values[0] }
  func retryBackup() async throws -> BackupSettings { values[0] }
  func disableBackup() async throws -> BackupSettings { values[0] }
}

private struct WindowStaticBackupReader: BackupSettingsReading {
  func fetchBackupSettings() async throws -> BackupSettings { value }
  func configureBackup(directory _: String) async throws -> BackupSettings { value }
  func retryBackup() async throws -> BackupSettings { value }
  func disableBackup() async throws -> BackupSettings { value }

  private var value: BackupSettings {
    BackupSettings(
      enabled: false,
      directory: nil,
      snapshotPath: nil,
      state: .disabled,
      lastAttemptAt: nil,
      lastSuccessAt: nil,
      error: nil
    )
  }
}
