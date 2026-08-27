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

  private func request(_ method: String, _ suffix: String, _ body: [String: String]?) async throws -> SyncSettings {
    let configuration = try AuthenticatedDaemonConfigurationLoader(
      receiptURL: receiptURL, tokenURL: tokenURL, fileReader: fileReader
    ).load()
    var request = URLRequest(url: configuration.baseURL.appending(path: "api/v1/settings/sync\(suffix)"))
    request.httpMethod = method
    request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    let (data, response) = try await transport.data(for: request)
    guard response.statusCode == 200 else { throw URLError(.badServerResponse) }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let value = try decoder.singleValueContainer().decode(String.self)
      let fractional = ISO8601DateFormatter()
      fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      let standard = ISO8601DateFormatter()
      standard.formatOptions = [.withInternetDateTime]
      guard let date = fractional.date(from: value) ?? standard.date(from: value) else {
        throw DecodingError.dataCorruptedError(
          in: try decoder.singleValueContainer(), debugDescription: "Invalid ISO-8601 date")
      }
      return date
    }
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
    else { throw URLError(.cannotParseResponse) }
    let envelope = try decoder.decode(SyncEnvelope.self, from: data)
    guard envelope.meta.schemaVersion == Self.supportedSchemaVersion,
      Self.isValid(envelope.data)
    else { throw URLError(.cannotParseResponse) }
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
    guard let directory = settings.directory, directory.hasPrefix("/"), !directory.contains("\n"),
      let deviceId = settings.deviceId,
      deviceId.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression) != nil
    else { return false }
    if settings.paused { return settings.state == .paused }
    return settings.state != .disabled && settings.state != .paused
  }
}

private struct SyncEnvelope: Decodable {
  let data: SyncSettings
  let meta: SyncMetadata
}

private struct SyncMetadata: Decodable { let schemaVersion: Int }

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
    do { settings = try await operation() }
    catch is CancellationError { return }
    catch { errorMessage = "Pimpampum could not update synchronization. Your local changes are safe." }
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
      let allowed = (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
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
          Text("Keep every Pimpampum project available on your other computers.")
            .font(.subheadline).foregroundStyle(.secondary)
        }
        Spacer()
        if let settings = store.settings, settings.enabled {
          Toggle("Synchronization", isOn: Binding(
            get: { !settings.paused },
            set: { value in Task { await store.setEnabled(value) } }
          )).labelsHidden().disabled(store.busy)
        }
      }

      if let settings = store.settings, settings.enabled {
        configured(settings)
      } else {
        Text("Choose a folder already synchronized by Google Drive, Dropbox, iCloud Drive, Syncthing, or rclone.")
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
    .frame(width: Self.contentWidth, minHeight: Self.contentHeight, alignment: .topLeading)
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
      Text("Pimpampum will use \(effectiveDirectory(pendingDirectory)). Existing snapshots may be imported before this Mac publishes its portfolio.")
    }
  }

  @ViewBuilder private func configured(_ settings: SyncSettings) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(settings.state.label, systemImage: settings.state == .healthy ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath")
        .foregroundStyle(settings.state == .healthy ? .green : .secondary)
      if let directory = settings.directory {
        Text("Shared folder").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Text(directory).font(.system(.caption, design: .monospaced)).lineLimit(2)
          .truncationMode(.middle).textSelection(.enabled)
      }
      Text("This device: \(settings.deviceId ?? deviceId)").font(.caption).foregroundStyle(.secondary)
      if settings.conflictCount > 0 {
        Label("\(settings.conflictCount) conflict(s) need attention", systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(.orange)
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
    panel.message = "Pimpampum will create or reuse a Pimpampum folder here."
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
}

private enum DesktopSettingsSection: String, CaseIterable, Identifiable {
  case synchronization = "Synchronization"
  case backup = "Backup"
  var id: Self { self }
}

@MainActor
private struct DesktopSettingsView: View {
  @ObservedObject var syncStore: SyncSettingsStore
  @ObservedObject var backupStore: BackupSettingsStore
  @State private var selection: DesktopSettingsSection

  init(
    syncStore: SyncSettingsStore,
    backupStore: BackupSettingsStore,
    showBackupInitially: Bool
  ) {
    self.syncStore = syncStore
    self.backupStore = backupStore
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
        }
      }
    }
    .frame(width: 520, minHeight: 400, alignment: .top)
  }
}

@MainActor
final class SyncSettingsWindowController: ObservableObject, SettingsWindowOpening {
  private let syncStore: SyncSettingsStore
  private let backupStore: BackupSettingsStore
  private let showBackupInitially: Bool
  private var windowController: NSWindowController?
  init(
    syncStore: SyncSettingsStore,
    backupStore: BackupSettingsStore,
    showBackupInitially: Bool = false
  ) {
    self.syncStore = syncStore
    self.backupStore = backupStore
    self.showBackupInitially = showBackupInitially
  }
  func openSettings() {
    if windowController == nil {
      let view = DesktopSettingsView(
        syncStore: syncStore,
        backupStore: backupStore,
        showBackupInitially: showBackupInitially
      )
      let window = NSWindow(contentViewController: NSHostingController(rootView: view))
      window.title = "Pimpampum Settings"
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
