import Combine
import Foundation

@MainActor
final class BackupSettingsStore: ObservableObject {
  @Published private(set) var settings: BackupSettings?
  @Published private(set) var activity: BackupSettingsActivity = .idle
  @Published private(set) var errorMessage: String?

  private let client: any BackupSettingsReading

  init(client: any BackupSettingsReading) {
    self.client = client
  }

  func load() async {
    await perform(.loading) { try await self.client.fetchBackupSettings() }
  }

  func configure(directory: String) async {
    await perform(.configuring) { try await self.client.configureBackup(directory: directory) }
  }

  func retry() async {
    await perform(.retrying) { try await self.client.retryBackup() }
  }

  func disable() async {
    await perform(.disabling) { try await self.client.disableBackup() }
  }

  private func perform(
    _ nextActivity: BackupSettingsActivity,
    operation: () async throws -> BackupSettings
  ) async {
    guard !activity.isBusy else { return }
    activity = nextActivity
    errorMessage = nil
    defer { activity = .idle }
    do {
      let nextSettings = try await operation()
      guard !Task.isCancelled else { return }
      settings = nextSettings
    } catch is CancellationError {
      return
    } catch let error as BackupSettingsClientError {
      guard !Task.isCancelled else { return }
      errorMessage = error.localizedDescription
    } catch {
      guard !Task.isCancelled else { return }
      errorMessage = "Pimpampum could not update backup settings. Try again."
    }
  }
}
