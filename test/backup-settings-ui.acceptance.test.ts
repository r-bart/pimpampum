import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('backup settings desktop surfaces', () => {
  it('ships a retained native macOS Settings window, menu actions, and directory-only picker', () => {
    const app = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/App.swift'),
      'utf8',
    );
    const popover = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift'),
      'utf8',
    );
    const settings = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/BackupSettingsView.swift'),
      'utf8',
    );
    const picker = readFileSync(
      join(root, 'platforms/macos/Sources/PimpampumMenuBar/BackupDirectoryPicker.swift'),
      'utf8',
    );
    const windowController = readFileSync(
      join(
        root,
        'platforms/macos/Sources/PimpampumMenuBar/BackupSettingsWindowController.swift',
      ),
      'utf8',
    );

    expect(app).toContain('@StateObject private var settingsWindowController');
    expect(app).toContain('BackupSettingsWindowController(store: backupSettingsStore)');
    expect(app).toContain('settingsWindowOpener: settingsWindowController');
    expect(app).toContain('quitApplication: { NSApplication.shared.terminate(nil) }');
    expect(app).not.toMatch(/Settings\s*\{/);
    expect(popover).toContain('settingsWindowOpener.openSettings()');
    expect(popover).toContain('Label("Settings…", systemImage: "gearshape")');
    expect(popover).toContain('Quit Pimpampum');
    expect(windowController).toContain('NSWindow(contentViewController:');
    expect(windowController).toContain('makeKeyAndOrderFront');
    expect(settings).toContain('Backup');
    expect(settings).toContain('Back Up Now');
    expect(settings).toContain('Disable');
    expect(settings).toContain('Refresh backup status');
    expect(picker).toContain('NSOpenPanel');
    expect(picker).toContain('canChooseDirectories = true');
    expect(picker).toContain('canChooseFiles = false');
  });

  it('ships a Quattro backup section, safe helper arguments, and manual fallback', () => {
    const popout = readFileSync(
      join(root, 'integrations/omarchy/pimpampum-status/StatusPopout.qml'),
      'utf8',
    );
    const service = readFileSync(
      join(root, 'integrations/omarchy/pimpampum-status/BackupService.qml'),
      'utf8',
    );

    expect(popout).toContain('Backup');
    expect(popout).toContain('FolderDialog');
    expect(popout).toContain('absolute path');
    expect(service).toMatch(/command\s*:\s*\[root\.helperPath/);
    expect(service).not.toMatch(/sh\s+-c|bash\s+-c|shellQuote|\+\s*(?:directory|path)/);
  });
});
