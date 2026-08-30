import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('settings desktop surfaces', () => {
  it('ships one retained native macOS settings window for synchronization and backup', () => {
    const app = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/App.swift'),
      'utf8',
    );
    const popover = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift'),
      'utf8',
    );
    const settings = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/SyncSettings.swift'),
      'utf8',
    );
    // The deterministic half of the synchronization panel lives in its own covered files, so this
    // acceptance test names where each rule belongs instead of reading one mixed file.
    const syncModels = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/SyncSettingsModels.swift'),
      'utf8',
    );
    const syncClient = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/SyncSettingsClient.swift'),
      'utf8',
    );

    expect(app).toContain('@StateObject private var settingsWindowController');
    expect(app).toContain('syncStore: syncSettingsStore');
    expect(app).toContain('backupStore: backupSettingsStore');
    expect(app).toContain('settingsWindowOpener: settingsWindowController');
    expect(app).toContain('quitApplication: { NSApplication.shared.terminate(nil) }');
    expect(app).not.toMatch(/Settings\s*\{/);
    expect(popover).toContain('settingsWindowOpener.openSettings()');
    expect(popover).toContain('Label("Settings…", systemImage: "gearshape")');
    expect(popover).toContain('Button(PimpampumBrand.quitTitle');
    expect(settings).toContain('NSWindow(contentViewController:');
    expect(settings).toContain('makeKeyAndOrderFront');
    expect(settings).toContain('Synchronization');
    expect(settings).toContain('case .backup: BackupSettingsView(store: backupStore)');
    expect(settings).toContain('.pickerStyle(.segmented)');
    expect(settings).toContain('Sync now');
    expect(settings).toContain('Forget shared folder…');
    expect(settings).toContain('NSOpenPanel');
    expect(settings).toContain('canChooseDirectories = true');
    expect(settings).toContain('canChooseFiles = false');
    expect(settings).toContain('"Use this shared folder?"');
    expect(settings).toContain('appendingPathComponent("Pimpampum"');
    expect(settings).toContain('Button("Open in Finder")');
    expect(settings).toContain('Pending snapshots:');
    expect(settings).toContain('Last sync:');
    expect(syncClient).toContain('.withFractionalSeconds');
    expect(settings).toContain('deviceIdentifier(ProcessInfo.processInfo.hostName)');
    expect(settings).toContain('static func isValidDeviceIdentifier(_ value: String)');
    expect(syncModels).toContain('func pause() async throws');
    expect(syncModels).toContain('func resume() async throws');
    expect(syncClient).toContain('static func isValid(_ settings: SyncSettings)');
  });

  it('ships Quattro settings with a native folder picker and safe helper arguments', () => {
    const popout = readFileSync(
      join(root, 'integrations/omarchy/pimpampum-status/StatusPopout.qml'),
      'utf8',
    );
    const service = readFileSync(
      join(root, 'integrations/omarchy/pimpampum-status/BackupService.qml'),
      'utf8',
    );

    expect(popout).toContain('Backup');
    expect(popout).toContain('pimpampum-folder-picker');
    expect(popout).not.toContain('QtQuick.Dialogs');
    expect(popout).toContain('Folder picker unavailable. Configure backup from the Pimpampum CLI.');
    expect(popout).not.toContain('Enter path manually');
    expect(service).toMatch(/command\s*:\s*\[root\.helperPath/);
    expect(service).not.toMatch(/sh\s+-c|bash\s+-c|shellQuote|\+\s*(?:directory|path)/);
    expect(popout).toContain('Synchronization');
    expect(popout).toContain('Sync now');
    expect(popout).toContain('Accessible.name: "Open help"');
    expect(popout).toContain('Specs in progress remain visible even when no task is claimed');
    expect(popout).toContain('What is the difference?');
    expect(popout).toContain('Why choose a shared folder?');
  });
});
