import AppKit
import Combine
import Foundation
import SwiftUI

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
