// Constants of the Quattro live smoke: the reviewer matrix, the capture guidance, the visual
// checklist, the Task 6.2 scenario order and the exact command shapes the evidence checkers pin.
// `check-quattro-evidence.mjs` and `check-omarchy-live-evidence.mjs` validate against these values,
// so a change here is an evidence contract change, not a refactor.

import { DEFAULT_COMMAND_TIMEOUT_MS } from '../lib/processRunner.mjs';

export const PLUGIN_ID = 'dev.pimpampum.status';
export const COMMAND_TIMEOUT_MS = DEFAULT_COMMAND_TIMEOUT_MS;
export const SCREENSHOT_NAMES = Object.freeze([
  'activePopout',
  'completedPopout',
  'offlineStale',
  'recovered',
  'workspaceOpen',
]);
export const OMARCHY_SCREENSHOT_ARGUMENTS = Object.freeze([
  'capture',
  'screenshot',
  'fullscreen',
  'save',
]);
export const SYSTEMD_PROBE_ARGUMENTS = Object.freeze([
  '--user',
  'show',
  'pimpampum.service',
  '--property=LoadState,UnitFileState,ActiveState',
]);

export const TASK_3_3_CAPTURE_GUIDANCE = Object.freeze({
  activePopout:
    'Keep the fixed circle-p mark visible with the active treatment outside it. Use the horizontal bar, open the bounded popout, and exercise project hover, keyboard focus, and activation before capture.',
  completedPopout:
    'Switch through the supported Quattro UI to the vertical bar and alternate light/dark theme, then show completed work and exercise its disclosure plus the collapsed Backup disclosure. Do not edit shell.json or QML; restore the original layout and theme before continuing.',
  offlineStale:
    'Show stale cached content and the urgent external error treatment while the fixed circle-p identity remains unchanged; it must not become an x, exclamation mark, or Wi-Fi glyph.',
  recovered:
    'Show the same fixed identity after recovery, with live content restored and no stale or offline message.',
  workspaceOpen:
    'Exercise mouse and keyboard activation where Quickshell supports it, then use the project row in the Pimpampum QML popout to open the workspace.',
});

export const TASK_3_3_REVIEW_MATRIX = Object.freeze([
  'Fixed circle-p identity and theme-foreground tint in every state; status is carried only by the external accent and shape.',
  'Horizontal side-by-side and vertical stacked bar layouts, using inherited Quattro geometry and theme tokens.',
  'Counts 7, 42, and 99+ (for 100 or more); zero hidden and negative source values clamped to zero.',
  'Light and dark themes.',
  'Complete, available, active/draft, empty, offline, stale, and credentials states.',
  'Hover plus visible keyboard focus and activation where Quickshell supports them.',
  'Bounded scrolling, long-content elision/disambiguation, completed disclosure, and safe workspace opening.',
  'Portfolio-to-Settings navigation inside the same bounded popout, keyboard-accessible back navigation, and no competing Quattro popout.',
  'Backup settings shown directly without nested disclosure; unconfigured, healthy, backing-up, and failed states; exact destination preview; explicit enable/disable confirmation; configure/retry/disable serialization and native folder-dialog behavior.',
  'Synchronization settings shown directly without nested disclosure; unconfigured, healthy, pending, paused, unavailable, failed, and conflicted states; provider-location selection; effective Pimpampum destination preview; explicit enable/forget confirmation; device identity, timestamps, pending count, open-folder, sync-now, and pause/resume behavior.',
]);

// States the reviewer is NOT asked to observe live, because a healthy installation cannot hold
// them long enough to be seen, or cannot produce them at all. Each stays covered by automated
// tests; listing them here keeps that exclusion explicit in the prompt and in the evidence binding.
export const TASK_3_3_AUTOMATED_ONLY = Object.freeze([
  'incompatible: the daemon pins overview schemaVersion 2 (overviewContract.ts), so a healthy installation can never emit another version; covered by test/service-omarchy.test.ts and test/omarchy-plugin.test.ts.',
  'importing and exporting: set and cleared inside one local filesystem operation (syncController.ts), so a poll observes them only by chance; covered by the sync controller tests.',
]);

export const TASK_6_2_SCENARIOS = Object.freeze([
  'bootstrap-no-node',
  'connect-codex',
  'connect-claude-code',
  'reject-wrong-architecture',
  'reject-wrong-hash',
  'reject-offline-download',
  'reject-interrupted-download',
  'quickshell-restart-preserves-daemon-and-connectors',
  'packaged-update-preserves-connectors',
  'receipt-owned-removal-preserves-data',
]);

/** Which capture proves each visual check; the reviewer approves this exact mapping. */
export const VISUAL_CHECKS = Object.freeze({
  themeInheritance: 'activePopout',
  horizontalTopLayout: 'activePopout',
  popoutCoordination: 'activePopout',
  activeCount: 'activePopout',
  completedCollapse: 'completedPopout',
  offlineRecovery: 'offlineStale',
  recovered: 'recovered',
  workspaceOpen: 'workspaceOpen',
});
