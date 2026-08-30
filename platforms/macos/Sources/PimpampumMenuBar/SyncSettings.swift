import AppKit
import Combine
import Foundation
import SwiftUI

enum SyncHealthState: String, Codable, Sendable {
  case disabled, paused, pending, importing, exporting, healthy, unavailable, error, conflict

  var label: String {
    switch self {
    case .disabled: "Not configured"
    case .paused: "Synchronization paused"
    case .pending: "Changes pending"
    case .importing: "Importing changes…"
    case .exporting: "Exporting changes…"
    case .healthy: "Up to date"
    case .unavailable: "Shared folder unavailable"
    case .error: "Synchronization needs attention"
    case .conflict: "Conflict requires attention"
    }
  }
}

struct SyncSettings: Codable, Equatable, Sendable {
  let enabled: Bool
  let paused: Bool
  let state: SyncHealthState
  let directory: String?
  let deviceId: String?
  let lastAttemptAt: Date?
  let lastImportAt: Date?
  let lastExportAt: Date?
  let pendingSnapshotCount: Int
  let conflictCount: Int
  let error: String?
}

protocol SyncSettingsReading: Sendable {
  func fetch() async throws -> SyncSettings
  func configure(directory: String, deviceId: String) async throws -> SyncSettings
  func reconcile() async throws -> SyncSettings
  func pause() async throws -> SyncSettings
  func resume() async throws -> SyncSettings
  func forget() async throws -> SyncSettings
}

enum SyncSettingsClientError: Error, Equatable, LocalizedError, Sendable {
  case unreadableReceipt
  case incompatibleReceiptSchema(Int)
  case invalidBaseURL
  case unreadableToken
  case invalidToken
  case unauthorized
  case incompatibleResponseSchema(Int)
  case serverStatus(Int, String?)
  case invalidPayload
  case transportFailure

  var errorDescription: String? {
    switch self {
    case .unreadableReceipt:
      "\(PimpampumBrand.displayName)'s installation receipt could not be read. Run pimpampum install."
    case .incompatibleReceiptSchema(let version):
      "The installed \(PimpampumBrand.displayName) receipt uses unsupported schema version \(version)."
    case .invalidBaseURL:
      "\(PimpampumBrand.displayName)'s configured URL must be an authenticated loopback HTTP endpoint."
    case .unreadableToken:
      "\(PimpampumBrand.displayName)'s local token file could not be read. Run pimpampum install."
    case .invalidToken:
      "\(PimpampumBrand.displayName)'s local token is invalid. Run pimpampum install to repair it."
    case .unauthorized:
      "\(PimpampumBrand.displayName) rejected the local token. Run pimpampum install to reconcile it."
    case .incompatibleResponseSchema(let version):
      "\(PimpampumBrand.displayName) returned unsupported synchronization schema version \(version)."
    case .serverStatus(let status, let message):
      message ?? "\(PimpampumBrand.displayName) returned HTTP status \(status)."
    case .invalidPayload:
      "\(PimpampumBrand.displayName) returned an invalid synchronization response."
    case .transportFailure:
      "\(PimpampumBrand.displayName) could not be reached. Check that the daemon is running."
    }
  }
}

struct SyncSettingsClient: SyncSettingsReading {
  static let supportedSchemaVersion = 1
  let receiptURL: URL
  let tokenURL: URL
  var fileReader: any OverviewFileReading = LocalOverviewFileReader()
  var transport: any OverviewTransport = URLSessionOverviewTransport()

  func fetch() async throws -> SyncSettings { try await request("GET", "", nil) }
  func configure(directory: String, deviceId: String) async throws -> SyncSettings {
    try await request("PUT", "", ["directory": directory, "deviceId": deviceId])
  }
  func reconcile() async throws -> SyncSettings { try await request("POST", "/reconcile", nil) }
  func pause() async throws -> SyncSettings { try await request("POST", "/pause", nil) }
  func resume() async throws -> SyncSettings { try await request("POST", "/resume", nil) }
  func forget() async throws -> SyncSettings { try await request("DELETE", "", nil) }

  private func request(_ method: String, _ suffix: String, _ body: [String: String]?) async throws
    -> SyncSettings
  {
    let configuration = try loadConfiguration()
    var request = URLRequest(
      url: configuration.baseURL.appending(path: "api/v1/settings/sync\(suffix)")
    )
    request.httpMethod = method
    request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.data(for: request)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw SyncSettingsClientError.transportFailure
    }
    guard response.statusCode != 401 else { throw SyncSettingsClientError.unauthorized }
    guard response.statusCode == 200 else {
      throw SyncSettingsClientError.serverStatus(
        response.statusCode,
        Self.serverMessage(from: data, redacting: configuration.token)
      )
    }
    return try Self.decodeSettings(data, rejecting: configuration.token)
  }

  private func loadConfiguration() throws -> SyncClientConfiguration {
    do {
      let configuration = try AuthenticatedDaemonConfigurationLoader(
        receiptURL: receiptURL,
        tokenURL: tokenURL,
        fileReader: fileReader
      ).load()
      return SyncClientConfiguration(baseURL: configuration.baseURL, token: configuration.token)
    } catch let error as AuthenticatedDaemonConfigurationError {
      throw Self.mapConfigurationError(error)
    }
  }

  private static func mapConfigurationError(_ error: AuthenticatedDaemonConfigurationError)
    -> SyncSettingsClientError
  {
    switch error {
    case .unreadableReceipt: .unreadableReceipt
    case .incompatibleReceiptSchema(let version): .incompatibleReceiptSchema(version)
    case .invalidBaseURL: .invalidBaseURL
    case .unreadableToken: .unreadableToken
    case .invalidToken: .invalidToken
    }
  }

  private static func decodeSettings(_ data: Data, rejecting token: String) throws -> SyncSettings {
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == ["data", "meta"],
      let metadata = root["meta"] as? [String: Any],
      Set(metadata.keys) == ["schemaVersion"],
      let payload = root["data"] as? [String: Any],
      Set(payload.keys) == [
        "enabled", "paused", "state", "directory", "deviceId", "lastAttemptAt",
        "lastImportAt", "lastExportAt", "pendingSnapshotCount", "conflictCount", "error",
      ]
    else { throw SyncSettingsClientError.invalidPayload }
    let envelope: SyncEnvelope
    do {
      envelope = try decoder().decode(SyncEnvelope.self, from: data)
    } catch {
      throw SyncSettingsClientError.invalidPayload
    }
    guard envelope.meta.schemaVersion == Self.supportedSchemaVersion else {
      throw SyncSettingsClientError.incompatibleResponseSchema(envelope.meta.schemaVersion)
    }
    guard Self.isValid(envelope.data), !(envelope.data.error?.contains(token) ?? false) else {
      throw SyncSettingsClientError.invalidPayload
    }
    return envelope.data
  }

  static func isValid(_ settings: SyncSettings) -> Bool {
    guard settings.pendingSnapshotCount >= 0, settings.conflictCount >= 0 else { return false }
    guard settings.enabled == (settings.directory != nil && settings.deviceId != nil) else {
      return false
    }
    if !settings.enabled {
      return settings.state == .disabled && !settings.paused
    }
    guard let directory = settings.directory, isSafeAbsolutePath(directory),
      let deviceId = settings.deviceId,
      deviceId.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression)
        != nil
    else { return false }
    if let error = settings.error,
      error.isEmpty || error.count > 500
        || error.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    {
      return false
    }
    if settings.paused { return settings.state == .paused }
    guard settings.state != .disabled && settings.state != .paused else { return false }
    return true
  }

  private static func isSafeAbsolutePath(_ path: String) -> Bool {
    !path.isEmpty && !path.contains("\0") && NSString(string: path).isAbsolutePath
  }

  private static func serverMessage(from data: Data, redacting token: String) -> String? {
    guard
      let envelope = try? JSONDecoder().decode(SyncServerErrorEnvelope.self, from: data),
      let message = envelope.error.message
    else { return nil }
    let redacted = message.replacingOccurrences(of: token, with: "[redacted]")
    let sanitized = redacted.unicodeScalars
      .filter { !CharacterSet.controlCharacters.contains($0) }
      .prefix(500)
    let value = String(String.UnicodeScalarView(sanitized))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  private static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let value = try container.decode(String.self)
      let fractional = ISO8601DateFormatter()
      fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = fractional.date(from: value) { return date }
      let standard = ISO8601DateFormatter()
      standard.formatOptions = [.withInternetDateTime]
      if let date = standard.date(from: value) { return date }
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Expected an ISO 8601 timestamp"
      )
    }
    return decoder
  }
}

private struct SyncClientConfiguration {
  let baseURL: URL
  let token: String
}

private struct SyncEnvelope: Decodable {
  let data: SyncSettings
  let meta: SyncMetadata
}

private struct SyncMetadata: Decodable { let schemaVersion: Int }

private struct SyncServerErrorEnvelope: Decodable {
  struct ServerError: Decodable {
    let message: String?
  }

  let error: ServerError
}

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

@MainActor
struct SyncSettingsView: View {
  static let contentWidth: CGFloat = 480
  static let contentHeight: CGFloat = 320
  @ObservedObject var store: SyncSettingsStore
  @State private var deviceId = Self.deviceIdentifier(ProcessInfo.processInfo.hostName)
  @State private var confirmingForget = false
  @State private var pendingDirectory: URL?

  static func deviceIdentifier(_ hostname: String) -> String {
    let lowered = hostname.lowercased()
    var result = ""
    var previousWasSeparator = false
    for scalar in lowered.unicodeScalars {
      let allowed =
        (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
      if allowed {
        result.unicodeScalars.append(scalar)
        previousWasSeparator = false
      } else if !result.isEmpty && !previousWasSeparator {
        result.append("-")
        previousWasSeparator = true
      }
    }
    result = String(result.prefix(63)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return result.isEmpty ? "macbook" : result
  }

  static func isValidDeviceIdentifier(_ value: String) -> Bool {
    value.range(
      of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#,
      options: .regularExpression
    ) != nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text("Synchronization").font(.title2.weight(.semibold))
          Text(
            "Keep every \(PimpampumBrand.displayName) project available on your other computers."
          )
          .font(.subheadline).foregroundStyle(.secondary)
        }
        Spacer()
        if let settings = store.settings, settings.enabled {
          Toggle(
            "Synchronization",
            isOn: Binding(
              get: { !settings.paused },
              set: { value in Task { await store.setEnabled(value) } }
            )
          ).labelsHidden().disabled(store.busy)
        }
      }

      if let settings = store.settings, settings.enabled {
        configured(settings)
      } else {
        Text(
          "Choose a folder already synchronized by Google Drive, Dropbox, iCloud Drive, Syncthing, or rclone."
        )
        .font(.subheadline).foregroundStyle(.secondary)
        TextField("Device name", text: $deviceId)
          .textFieldStyle(.roundedBorder)
          .disabled(store.busy)
        Button("Choose shared folder…") { chooseFolder() }
          .buttonStyle(.borderedProminent)
          .disabled(store.busy || !Self.isValidDeviceIdentifier(deviceId))
      }

      if let error = store.errorMessage ?? store.settings?.error {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption).foregroundStyle(.red).textSelection(.enabled)
      }
      Spacer(minLength: 0)
    }
    .padding(24)
    .frame(width: Self.contentWidth, alignment: .topLeading)
    .frame(minHeight: Self.contentHeight, alignment: .topLeading)
    .task { await store.load() }
    .confirmationDialog(
      "Forget this shared folder?",
      isPresented: $confirmingForget,
      titleVisibility: .visible
    ) {
      Button("Forget shared folder", role: .destructive) { Task { await store.forget() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Your local projects stay on this Mac. Only synchronization settings are removed.")
    }
    .confirmationDialog(
      "Use this shared folder?",
      isPresented: Binding(
        get: { pendingDirectory != nil },
        set: { if !$0 { pendingDirectory = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Enable synchronization") {
        guard let directory = pendingDirectory else { return }
        pendingDirectory = nil
        Task { await store.configure(directory: directory.path, deviceId: deviceId) }
      }
      Button("Cancel", role: .cancel) { pendingDirectory = nil }
    } message: {
      Text(
        "\(PimpampumBrand.displayName) will use \(effectiveDirectory(pendingDirectory)). Existing snapshots may be imported before this Mac publishes its portfolio."
      )
    }
  }

  @ViewBuilder private func configured(_ settings: SyncSettings) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(
        settings.state.label,
        systemImage: settings.state == .healthy
          ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath"
      )
      .foregroundStyle(settings.state == .healthy ? .green : .secondary)
      if let directory = settings.directory {
        Text("Shared folder").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Text(directory).font(.system(.caption, design: .monospaced)).lineLimit(2)
          .truncationMode(.middle).textSelection(.enabled)
      }
      Text("This device: \(settings.deviceId ?? deviceId)").font(.caption).foregroundStyle(
        .secondary)
      if settings.conflictCount > 0 {
        Label(
          "\(settings.conflictCount) conflict(s) need attention",
          systemImage: "exclamationmark.triangle.fill"
        )
        .foregroundStyle(.orange)
      }
      if let guidance = Self.recoveryGuidance(for: settings) {
        Text(guidance)
          .font(.caption)
          .foregroundStyle(settings.state == .conflict ? .orange : .secondary)
          .textSelection(.enabled)
      }
      Text("Pending snapshots: \(settings.pendingSnapshotCount)")
        .font(.caption).foregroundStyle(.secondary)
      Text("Last sync: \(Self.lastSyncLabel(settings))")
        .font(.caption).foregroundStyle(.secondary)
      Divider()
      HStack {
        Button(store.busy ? "Synchronizing…" : "Sync now") { Task { await store.syncNow() } }
          .buttonStyle(.borderedProminent).disabled(store.busy || settings.paused)
        Button("Change folder…") { chooseFolder() }.disabled(store.busy)
        if let directory = settings.directory {
          Button("Open in Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: directory)) }
            .disabled(store.busy)
        }
        Spacer()
        Button("Forget shared folder…", role: .destructive) { confirmingForget = true }
          .disabled(store.busy)
      }
    }
  }

  private func chooseFolder() {
    let panel = NSOpenPanel()
    panel.title = "Choose shared folder"
    panel.prompt = "Use folder"
    panel.message = "\(PimpampumBrand.displayName) will create or reuse a Pimpampum folder here."
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let url = panel.url else { return }
    pendingDirectory = url.standardizedFileURL
  }

  private func effectiveDirectory(_ url: URL?) -> String {
    guard let url else { return "the selected folder" }
    return url.appendingPathComponent("Pimpampum", isDirectory: true).path
  }

  static func lastSyncLabel(_ settings: SyncSettings) -> String {
    guard let date = [settings.lastImportAt, settings.lastExportAt].compactMap({ $0 }).max()
    else { return "Never" }
    return date.formatted(date: .abbreviated, time: .shortened)
  }

  static func recoveryGuidance(for settings: SyncSettings) -> String? {
    switch settings.state {
    case .conflict:
      "Resolve conflicts in Terminal with `pimpampum sync conflicts`, then choose Sync now. Your local projects stay available while you decide."
    case .unavailable:
      "Your local projects are safe on this Mac. Reconnect the shared folder or choose another folder to resume synchronization."
    case .error:
      "Your local projects are safe on this Mac. Fix the reported problem, then choose Sync now."
    default:
      nil
    }
  }
}

private enum DesktopSettingsSection: String, CaseIterable, Identifiable {
  case synchronization = "Synchronization"
  case backup = "Backup"
  case updates = "Updates"
  var id: Self { self }
}

@MainActor
private struct DesktopSettingsView: View {
  @ObservedObject var syncStore: SyncSettingsStore
  @ObservedObject var backupStore: BackupSettingsStore
  @ObservedObject var updateStore: UpdateSettingsStore
  @State private var selection: DesktopSettingsSection

  init(
    syncStore: SyncSettingsStore,
    backupStore: BackupSettingsStore,
    updateStore: UpdateSettingsStore,
    showBackupInitially: Bool
  ) {
    self.syncStore = syncStore
    self.backupStore = backupStore
    self.updateStore = updateStore
    _selection = State(initialValue: showBackupInitially ? .backup : .synchronization)
  }

  var body: some View {
    VStack(spacing: 0) {
      Picker("Settings section", selection: $selection) {
        ForEach(DesktopSettingsSection.allCases) { section in
          Text(section.rawValue).tag(section)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding([.top, .horizontal], 20)

      Group {
        switch selection {
        case .synchronization: SyncSettingsView(store: syncStore)
        case .backup: BackupSettingsView(store: backupStore)
        case .updates: UpdateSettingsView(store: updateStore)
        }
      }
    }
    .frame(width: 520, alignment: .top)
    .frame(minHeight: 400, alignment: .top)
  }
}

@MainActor
final class SyncSettingsWindowController: ObservableObject, SettingsWindowOpening {
  private let syncStore: SyncSettingsStore
  private let backupStore: BackupSettingsStore
  private let updateStore: UpdateSettingsStore
  private let showBackupInitially: Bool
  private var windowController: NSWindowController?
  init(
    syncStore: SyncSettingsStore,
    backupStore: BackupSettingsStore,
    updateStore: UpdateSettingsStore,
    showBackupInitially: Bool = false
  ) {
    self.syncStore = syncStore
    self.backupStore = backupStore
    self.updateStore = updateStore
    self.showBackupInitially = showBackupInitially
  }
  func openSettings() {
    if windowController == nil {
      let view = DesktopSettingsView(
        syncStore: syncStore,
        backupStore: backupStore,
        updateStore: updateStore,
        showBackupInitially: showBackupInitially
      )
      let window = NSWindow(contentViewController: NSHostingController(rootView: view))
      window.title = PimpampumBrand.settingsTitle
      window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
      window.contentMinSize = NSSize(width: 520, height: 400)
      window.setContentSize(NSSize(width: 520, height: 400))
      window.isReleasedWhenClosed = false
      window.center()
      windowController = NSWindowController(window: window)
    }
    NSApplication.shared.activate(ignoringOtherApps: true)
    windowController?.showWindow(nil)
    windowController?.window?.makeKeyAndOrderFront(nil)
    Task {
      async let syncLoad: Void = syncStore.load()
      async let backupLoad: Void = backupStore.load()
      _ = await (syncLoad, backupLoad)
    }
  }
}
