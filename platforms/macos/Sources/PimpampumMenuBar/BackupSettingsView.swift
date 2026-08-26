import SwiftUI

enum BackupSettingsCopy {
  static let title = "Backup"
  static let description =
    "Keep one current snapshot after every change. The live database stays local."
  static let refresh = "Refresh backup status"
  static let loading = "Loading backup settings…"
  static let disabled = "Automatic backup is off"
  static let folder = "Folder"
  static let chooseFolder = "Choose Folder…"
  static let change = "Change…"
  static let openInFinder = "Open in Finder"
  static let backUpNow = "Back Up Now"
  static let tryAgain = "Try Again"
  static let disable = "Disable"
}

enum BackupSettingsViewVariant: Equatable {
  case loading
  case disabled
  case configured(BackupHealthState)
  case installationError
}

struct BackupSettingsViewPresentation: Equatable {
  let variant: BackupSettingsViewVariant
  let controlsDisabled: Bool
  let refreshDisabled: Bool
  let primaryActionTitle: String
  let inlineError: String?
}

@MainActor
struct BackupSettingsView: View {
  static let contentWidth: CGFloat = 460
  static let contentHeight: CGFloat = 270
  static let configuredPathLineLimit = 2

  @ObservedObject var store: BackupSettingsStore
  let directoryPicker: any BackupDirectoryPicking
  let directoryOpener: any BackupDirectoryOpening

  @State private var finderError: String?
  @State private var pendingDirectory: String?

  init(
    store: BackupSettingsStore,
    directoryPicker: any BackupDirectoryPicking = BackupDirectoryPicker(),
    directoryOpener: any BackupDirectoryOpening = BackupDirectoryOpener()
  ) {
    self.store = store
    self.directoryPicker = directoryPicker
    self.directoryOpener = directoryOpener
  }

  static func presentation(
    settings: BackupSettings?,
    activity: BackupSettingsActivity,
    pendingDirectory: String?,
    operationError: String?,
    finderError: String?
  ) -> BackupSettingsViewPresentation {
    let inlineError = operationError ?? finderError
    let isPending = activity.isBusy || pendingDirectory != nil || settings?.state == .pending
    let isInstallationError = settings == nil && inlineError != nil
    let controlsDisabled = isPending || isInstallationError
    let variant: BackupSettingsViewVariant

    if settings == nil, activity == .loading, inlineError == nil, pendingDirectory == nil {
      variant = .loading
    } else if isInstallationError {
      variant = .installationError
    } else if pendingDirectory != nil {
      variant = .configured(.pending)
    } else if let settings, settings.enabled, settings.directory != nil {
      variant = .configured(isPending ? .pending : settings.state)
    } else {
      variant = .disabled
    }

    let primaryActionTitle =
      variant == .configured(.error) ? BackupSettingsCopy.tryAgain : BackupSettingsCopy.backUpNow
    return BackupSettingsViewPresentation(
      variant: variant,
      controlsDisabled: controlsDisabled,
      refreshDisabled: isPending,
      primaryActionTitle: primaryActionTitle,
      inlineError: inlineError
    )
  }

  private var presentation: BackupSettingsViewPresentation {
    Self.presentation(
      settings: store.settings,
      activity: store.activity,
      pendingDirectory: pendingDirectory,
      operationError: store.errorMessage,
      finderError: finderError
    )
  }

  private var effectiveDirectory: String? {
    pendingDirectory ?? store.settings?.directory
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(BackupSettingsCopy.title)
            .font(.title2.weight(.semibold))
          Spacer()
          Button {
            Task { await store.load() }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .buttonStyle(.borderless)
          .disabled(presentation.refreshDisabled)
          .help(BackupSettingsCopy.refresh)
          .accessibilityLabel(BackupSettingsCopy.refresh)
        }
        Text(BackupSettingsCopy.description)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      switch presentation.variant {
      case .loading:
        loadingContent
      case .disabled:
        disabledContent
      case .installationError:
        installationErrorContent
      case .configured(let state):
        if let directory = effectiveDirectory {
          configuredContent(
            directory: directory,
            state: state,
            lastSuccessAt: store.settings?.lastSuccessAt,
            backupError: state == .error ? store.settings?.error : nil
          )
        } else {
          disabledContent
        }
      }

      if let message = presentation.inlineError {
        Label(message, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.red)
          .textSelection(.enabled)
      }

      Spacer(minLength: 0)
    }
    .padding(24)
    .frame(width: Self.contentWidth, alignment: .topLeading)
    .frame(minHeight: Self.contentHeight, alignment: .topLeading)
  }

  @ViewBuilder
  private func configuredContent(
    directory: String,
    state: BackupHealthState,
    lastSuccessAt: Date?,
    backupError: String?
  ) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 10) {
        Text(BackupSettingsCopy.folder)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .textCase(.uppercase)

        Text(directory)
          .font(.system(.caption, design: .monospaced))
          .lineLimit(Self.configuredPathLineLimit)
          .truncationMode(.middle)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)

        HStack {
          Button(BackupSettingsCopy.change) { chooseDirectory(currentPath: directory) }
            .disabled(presentation.controlsDisabled)
          Button(BackupSettingsCopy.openInFinder) { openInFinder(directory) }
            .disabled(presentation.controlsDisabled)
          Spacer()
        }
        .controlSize(.small)
      }

      Divider()

      HStack(alignment: .top, spacing: 12) {
        statusRow(state: state, lastSuccessAt: lastSuccessAt, backupError: backupError)

        Spacer(minLength: 8)

        HStack(spacing: 8) {
          Button(presentation.primaryActionTitle) {
            Task { await store.retry() }
          }
          .buttonStyle(.borderedProminent)
          .disabled(presentation.controlsDisabled)

          Button(BackupSettingsCopy.disable, role: .destructive) {
            Task { await store.disable() }
          }
          .disabled(presentation.controlsDisabled)
        }
      }
    }
  }

  private var disabledContent: some View {
    VStack(alignment: .leading, spacing: 16) {
      disabledStatus
      Button(BackupSettingsCopy.chooseFolder) { chooseDirectory(currentPath: nil) }
        .buttonStyle(.borderedProminent)
        .disabled(presentation.controlsDisabled)
    }
    .padding(.vertical, 6)
  }

  private var installationErrorContent: some View {
    VStack(alignment: .leading, spacing: 16) {
      disabledStatus
      Button(BackupSettingsCopy.chooseFolder) { chooseDirectory(currentPath: nil) }
        .buttonStyle(.borderedProminent)
        .disabled(true)
    }
  }

  private var disabledStatus: some View {
    HStack(spacing: 10) {
      Image(systemName: "externaldrive")
        .foregroundStyle(.secondary)
        .frame(width: 26, height: 26)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
        .accessibilityHidden(true)
      Text(BackupSettingsCopy.disabled)
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }

  private var loadingContent: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text(BackupSettingsCopy.loading)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      HStack(spacing: 8) {
        Button(BackupSettingsCopy.backUpNow) {}
        Button(BackupSettingsCopy.change) {}
      }
      .disabled(true)
    }
  }

  private func statusRow(
    state: BackupHealthState,
    lastSuccessAt: Date?,
    backupError: String?
  ) -> some View {
    HStack(alignment: .top, spacing: 8) {
      if state == .pending {
        ProgressView()
          .controlSize(.small)
      } else {
        Image(systemName: state.symbolName)
          .foregroundStyle(statusColor(state))
      }

      VStack(alignment: .leading, spacing: 2) {
        Text(state.label)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(statusColor(state))
        if let backupError {
          Text(backupError)
            .font(.caption)
            .foregroundStyle(.red)
            .textSelection(.enabled)
        }
        if let lastSuccess = lastSuccessAt {
          Text("Last successful backup \(lastSuccess.formatted(date: .abbreviated, time: .shortened))")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  private func chooseDirectory(currentPath: String?) {
    let initialDirectory = currentPath.map { URL(fileURLWithPath: $0, isDirectory: true) }
    guard let directory = directoryPicker.chooseDirectory(initialDirectory: initialDirectory) else {
      return
    }
    finderError = nil
    pendingDirectory = directory.path
    Task {
      await store.configure(directory: directory.path)
      pendingDirectory = nil
    }
  }

  private func openInFinder(_ directory: String) {
    do {
      try directoryOpener.openDirectory(at: directory)
      finderError = nil
    } catch {
      finderError = error.localizedDescription
    }
  }

  private func statusColor(_ state: BackupHealthState) -> Color {
    switch state {
    case .healthy: .green
    case .error: .red
    case .pending: .orange
    case .disabled: .secondary
    }
  }
}
