import Combine
import Foundation

@MainActor
final class SyncSettingsStore: ObservableObject {
  @Published private(set) var settings: SyncSettings?
  @Published private(set) var busy = false
  @Published private(set) var errorMessage: String?
  private let client: any SyncSettingsReading

  init(client: any SyncSettingsReading) { self.client = client }

  func load() async { await perform { try await self.client.fetch() } }
  func configure(directory: String, deviceId: String) async {
    await perform { try await self.client.configure(directory: directory, deviceId: deviceId) }
  }
  func syncNow() async { await perform { try await self.client.reconcile() } }
  func setEnabled(_ enabled: Bool) async {
    await perform { enabled ? try await self.client.resume() : try await self.client.pause() }
  }
  func forget() async { await perform { try await self.client.forget() } }

  private func perform(_ operation: () async throws -> SyncSettings) async {
    guard !busy else { return }
    busy = true
    errorMessage = nil
    defer { busy = false }
    do { settings = try await operation() } catch is CancellationError { return } catch let error
      as LocalizedError
    {
      errorMessage = error.localizedDescription
    } catch {
      errorMessage =
        "\(PimpampumBrand.displayName) could not update synchronization. Your local changes are safe."
    }
  }
}
