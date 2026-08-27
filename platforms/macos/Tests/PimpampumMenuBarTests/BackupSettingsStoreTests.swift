import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite(.serialized)
@MainActor
struct BackupSettingsStoreTests {
  @Test
  func publishesEverySuccessfulOperationAndItsActivity() async {
    let values = [
      settings(.disabled), settings(.pending), settings(.healthy), settings(.disabled),
    ]
    let client = SequenceBackupSettingsReader(values.map { .success($0) })
    let store = BackupSettingsStore(client: client)

    #expect(store.settings == nil)
    #expect(store.activity == .idle)
    #expect(!store.activity.isBusy)

    await store.load()
    #expect(store.settings == values[0])
    await store.configure(directory: "/tmp/Backup")
    #expect(store.settings == values[1])
    await store.retry()
    #expect(store.settings == values[2])
    await store.disable()
    #expect(store.settings == values[3])
    #expect(store.activity == .idle)
    #expect(store.errorMessage == nil)
    #expect(await client.calls == ["fetch", "configure:/tmp/Backup", "retry", "disable"])
  }

  @Test
  func ignoresConcurrentActionsWhileOneRequestIsInFlight() async {
    let client = SuspendedBackupSettingsReader(result: settings(.healthy))
    let store = BackupSettingsStore(client: client)
    let load = Task { await store.load() }
    #expect(await eventually { await client.hasContinuation })
    #expect(store.activity == .loading)
    #expect(store.activity.isBusy)

    await store.configure(directory: "/ignored")
    await store.retry()
    await store.disable()
    #expect(await client.callCount == 1)

    await client.resume()
    await load.value
    #expect(store.settings?.state == .healthy)
    #expect(store.activity == .idle)
  }

  @Test
  func surfacesKnownErrorsWithoutDiscardingTheLastGoodSettings() async {
    let existing = settings(.healthy)
    let client = SequenceBackupSettingsReader([
      .success(existing), .clientFailure(.serverStatus(400, "Choose another folder.")),
    ])
    let store = BackupSettingsStore(client: client)
    await store.load()
    await store.configure(directory: "/missing")

    #expect(store.settings == existing)
    #expect(store.errorMessage == "Choose another folder.")
    #expect(store.activity == .idle)
  }

  @Test
  func refreshRecoversAfterInstallationCredentialsAreRepaired() async {
    let repaired = settings(.disabled)
    let client = SequenceBackupSettingsReader([
      .clientFailure(.unreadableReceipt), .success(repaired),
    ])
    let store = BackupSettingsStore(client: client)

    await store.load()
    #expect(store.settings == nil)
    #expect(store.errorMessage?.contains("Run pimpampum install") == true)

    await store.load()
    #expect(store.settings == repaired)
    #expect(store.errorMessage == nil)
    #expect(await client.calls == ["fetch", "fetch"])
  }

  @Test
  func replacesUnknownFailuresWithAFixedNonSensitiveMessage() async {
    let store = BackupSettingsStore(client: SequenceBackupSettingsReader([.otherFailure]))
    await store.load()
    #expect(store.settings == nil)
    #expect(store.errorMessage == "pim • pam • pum could not update backup settings. Try again.")
  }

  @Test
  func cancellationLeavesThePublishedStateUntouched() async {
    let store = BackupSettingsStore(client: SequenceBackupSettingsReader([.cancellation]))
    await store.load()
    #expect(store.settings == nil)
    #expect(store.errorMessage == nil)
    #expect(store.activity == .idle)
  }

  @Test
  func cancelledTasksIgnoreLateSuccessAndFailureResults() async {
    let outcomes: [CancellationIgnoringBackupReader.Outcome] = [
      .success(settings(.healthy)),
      .clientFailure(.unauthorized),
      .otherFailure,
    ]

    for outcome in outcomes {
      let client = CancellationIgnoringBackupReader(outcome: outcome)
      let store = BackupSettingsStore(client: client)
      let load = Task { await store.load() }
      #expect(await eventually { await client.hasContinuation })
      load.cancel()
      await client.resume()
      await load.value

      #expect(store.settings == nil)
      #expect(store.errorMessage == nil)
      #expect(store.activity == .idle)
    }
  }

  @Test
  func everyHealthStateHasCompletePresentationMetadata() {
    for state in BackupHealthState.allCases {
      #expect(!state.label.isEmpty)
      #expect(!state.symbolName.isEmpty)
    }
  }

  private func settings(_ state: BackupHealthState) -> BackupSettings {
    BackupSettings(
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

private actor SequenceBackupSettingsReader: BackupSettingsReading {
  enum Outcome: Sendable {
    case success(BackupSettings)
    case clientFailure(BackupSettingsClientError)
    case otherFailure
    case cancellation
  }

  private var outcomes: [Outcome]
  private(set) var calls: [String] = []

  init(_ outcomes: [Outcome]) { self.outcomes = outcomes }

  func fetchBackupSettings() async throws -> BackupSettings { try next("fetch") }
  func configureBackup(directory: String) async throws -> BackupSettings {
    try next("configure:\(directory)")
  }
  func retryBackup() async throws -> BackupSettings { try next("retry") }
  func disableBackup() async throws -> BackupSettings { try next("disable") }

  private func next(_ call: String) throws -> BackupSettings {
    calls.append(call)
    let outcome = outcomes.removeFirst()
    return switch outcome {
    case .success(let settings): settings
    case .clientFailure(let error): throw error
    case .otherFailure: throw TestFailure.expected
    case .cancellation: throw CancellationError()
    }
  }
}

private actor SuspendedBackupSettingsReader: BackupSettingsReading {
  private let result: BackupSettings
  private var continuation: CheckedContinuation<BackupSettings, Never>?
  private(set) var callCount = 0

  init(result: BackupSettings) { self.result = result }

  var hasContinuation: Bool { continuation != nil }

  func fetchBackupSettings() async throws -> BackupSettings {
    callCount += 1
    return await withCheckedContinuation { continuation = $0 }
  }

  func configureBackup(directory _: String) async throws -> BackupSettings { result }
  func retryBackup() async throws -> BackupSettings { result }
  func disableBackup() async throws -> BackupSettings { result }

  func resume() {
    continuation?.resume(returning: result)
    continuation = nil
  }
}

private actor CancellationIgnoringBackupReader: BackupSettingsReading {
  enum Outcome: Sendable {
    case success(BackupSettings)
    case clientFailure(BackupSettingsClientError)
    case otherFailure
  }

  private let outcome: Outcome
  private var continuation: CheckedContinuation<Void, Never>?

  init(outcome: Outcome) { self.outcome = outcome }

  var hasContinuation: Bool { continuation != nil }

  func fetchBackupSettings() async throws -> BackupSettings {
    await withCheckedContinuation { continuation = $0 }
    return try result()
  }

  func configureBackup(directory _: String) async throws -> BackupSettings { try result() }
  func retryBackup() async throws -> BackupSettings { try result() }
  func disableBackup() async throws -> BackupSettings { try result() }

  func resume() {
    continuation?.resume()
    continuation = nil
  }

  private func result() throws -> BackupSettings {
    return switch outcome {
    case .success(let value): value
    case .clientFailure(let error): throw error
    case .otherFailure: throw TestFailure.expected
    }
  }
}
