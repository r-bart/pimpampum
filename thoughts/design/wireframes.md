# Wireframe Specs: Automatic Backup Settings

**Date**: 2026-08-26  
**Screens**: 2  
**Status**: approved

## Screen: macOS Backup Settings

**Location**: Menu bar popover → Settings… → Backup  
**Primary action**: Choose a synchronized backup folder.

### Layout

```text
┌────────────────────────────────────────┐
│ Backup                                 │
│ Keep one current snapshot after every  │
│ change. The live database stays local. │
│                                        │
│ Folder   ~/Library/Mobile Documents/…  │
│          [Choose…] [Open in Finder]    │
│                                        │
│ ● Up to date · Today at 09:42          │
│                                        │
│ [Back Up Now]              [Disable]   │
└────────────────────────────────────────┘
```

### States

- **Loading**: controls disabled, compact progress indicator.
- **Disabled**: no path; primary `Choose Folder…` button.
- **Pending**: selected path visible; refresh progress shown.
- **Healthy**: green status and last-success time.
- **Error**: red inline message; `Try Again` and `Change Folder…`; mutation data remains safe locally.

### Interaction

- `Choose…` opens a directory-only `NSOpenPanel`.
- Confirming sends the canonical API PUT; cancel changes nothing.
- `Open in Finder` uses `NSWorkspace` with the configured directory URL.
- `Disable` requires no destructive confirmation because it does not delete the snapshot.

## Screen: Quattro Backup Settings

**Location**: Pimpampum status popout → Backup disclosure  
**Primary action**: Choose or enter a synchronized backup folder.

### Layout

```text
┌──────────────────────────────────────┐
│ Pimpampum                      ● 2   │
│ Projects …                          │
│                                      │
│ ▾ Backup                             │
│   /home/roberto/Dropbox/Pimpampum    │
│   ● Up to date · 09:42               │
│   [Choose…] [Open] [Back Up Now]     │
│                           [Disable]   │
└──────────────────────────────────────┘
```

### States

The same five semantic states as macOS. If `FolderDialog` is unavailable, `Choose…` is omitted and an absolute-path text field plus `Save` remains available. The daemon validates all input.

### Interaction

- Folder selection or manual text is passed as one separate helper argument.
- `Open` invokes `xdg-open` with the path as a separate argument.
- Existing projects and active-work status remain read-only.

## Component Boundary

- Shared daemon: status vocabulary and validation.
- macOS: `BackupSettingsClient`, `BackupSettingsStore`, `BackupSettingsView`, native picker adapter.
- Quattro: `BackupService.qml`, Backup disclosure, receipt-owned helper.
- No desktop-local copy of the configured path.
