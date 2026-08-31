# Pimpampum Status for Omarchy Quattro

This native `bar-widget` gives Omarchy Quattro a compact view of the single
Pimpampum instance running for the current user. It shows semantic
project health, active-claim count, active work, specs in progress, available work, and a collapsed
completed-spec group. Selecting a project or spec opens its registered workspace root with
`xdg-open`. Settings contains separate Updates, Synchronization, Backup, and service cards. Help is
a dedicated page opened from the persistent footer.

The integration targets the Quattro plugin contract pinned at Omarchy commit
`0ae1694830b6bd9511042fe1b89a0062d8c083cb`. Waybar is not supported.

## Status UX

The compact identity is always the same theme-tinted circle containing a lowercase `p`. State stays
external through badge shape/accent, tooltip, popout copy, and an optional active-claim count. Zero
is hidden and values above 99 display as `99+`; offline and error states never replace the mark.

Clicking opens one bounded 380-unit native `PopupCard`. Its Portfolio view is ordered as connection
state, Active work, Specs in progress, Projects, and collapsed Completed specs. Active work names
the claimed task plus its project, Spec, agent, and lease; in-progress Specs remain visible without
an active claim and show completed versus total tasks. **Settings** switches the same card to a
dedicated second view showing Updates, Synchronization, and Backup controls directly, without
nested disclosures. The fixed footer opens Help on the left and stops or starts Pimpampum on the
right. A 44-unit vector header icon opens Settings and changes to a back arrow on internal pages,
without opening a competing Quattro popout.
Horizontal bars place mark and count side by side;
vertical bars stack them. Project rows open the exact registered workspace root.

## Security boundary

- The widget launches the installed `pimpampum-overview` helper by absolute
  path. During installation Pimpampum binds that receipt-owned helper to the
  canonical Node, CLI, data-directory, host, and port configuration.
  Authentication remains inside the CLI and no bearer token enters QML,
  settings, or process arguments.
- Update actions launch the bounded `pimpampum-update` helper. It accepts only `check` and
  `install`, and maps them to `pimpampum update:check` and `pimpampum update`. The helper takes no
  version, registry, or path argument, so the popout cannot select what gets installed.
- Backup actions launch the separate receipt-owned `pimpampum-backup` helper.
  It accepts only `status`, `configure <absolute-directory>`, `retry`, and
  `disable`, delegates to the canonical JSON CLI contract, and passes the
  selected directory as one process argument. No token enters QML.
- Synchronization actions use the bounded `pimpampum-sync` helper. It derives a safe device ID from
  the hostname and accepts only status, configure, sync-now, pause, resume, conflict-list, and forget.
- Service actions use the bounded `pimpampum-service` helper. It accepts only status, start, stop,
  and restart for the fixed `pimpampum.service` systemd user unit; it accepts no user-controlled
  service name or shell input. Stopping the daemon leaves the Quickshell widget installed so the
  user can start it again without a terminal.
- Workspace paths are accepted only when absolute and are passed to `xdg-open`
  as one argument. They are never evaluated as shell source.
- The UI exposes no project, task, or claim mutation. Its writes are limited to the fixed service
  lifecycle, the fixed update installation, and daemon-owned synchronization and automatic-backup
  preferences.
- Plugin installation, ownership checks, lifecycle locking, rollback, status,
  and removal are owned by the same `pimpampum` CLI lifecycle.

## Install

Run the single automatic lifecycle command on the Quattro machine:

```bash
pimpampum install
```

`pimpampum install` detects Quattro, installs the user service and plugin under
one lifecycle lock, validates the staged candidate with `omarchy plugin
validate`, asks `omarchy-shell` to rescan, and enables it with the official
plugin command. It never reads or edits `shell.json` directly. A failed
installation restores the previous owned state and leaves unrelated plugins
alone.

The repository-local `install.sh` remains a thin wrapper around the bounded
plugin lifecycle. After an official plugin fast-forward, that lifecycle compares
the checked-in runtime version, Linux target, and archive SHA with its private
receipt under the same setup lock. An unchanged pin performs no runtime work; a
new version or target invokes the verified bootstrap and commits the new receipt
only after the packaged installer succeeds. A checksum change without a version
change fails closed because release assets are immutable. The previous runtime
and connector route remain available if reconciliation fails. Installed helpers
do not depend on the graphical session's `PATH`.

## Update settings

Open **Settings** and use the **Updates** card. **Check for updates** is read-only. When npm
publishes a newer release the button becomes **Install update**, which installs it and reconciles
the background service and the plugin.

A failure shows the reason the CLI reported, not a guess. The CLI writes its typed error envelope
to stderr, so the card reads that stream first and falls back to stdout. A registry policy, a
permission error, and an offline machine therefore read as three different messages.

## Backup settings

Open **Settings** in the Pimpampum popout and use the **Backup** card. **Choose backup
destination…** opens the native GTK directory picker. If the picker is unavailable, the card points
to the bounded Pimpampum CLI instead of exposing a second path-entry implementation. **Open** launches the configured directory through
`xdg-open`, **Back Up Now** retries immediately, and **Disable** stops future
automatic refreshes without deleting the existing snapshot.

The live SQLite database remains local. Only `pimpampum-latest.sqlite` is
written to the selected directory, which may be inside Dropbox, Google Drive,
or another synchronized folder. Configuration errors and backup health are
reported inline; a failed backup never invalidates the project mutation that
triggered it.

## Synchronization settings

Open **Settings** and use the **Synchronization** card to exchange portfolio state with other computers.
Choose a location already synchronized by Dropbox, Syncthing, Google Drive through a mounted
filesystem, or a similar provider. Selection alone does not enable synchronization: the widget
previews the effective destination and explains that existing snapshots may be imported before the
user confirms **Enable synchronization**.

Pimpampum creates or reuses a `Pimpampum` child inside the selected location, unless that location
is already named `Pimpampum`. It shows the effective path and derived device identity after setup.
**Sync now**, pause/resume, shared-folder opening, and forgetting remain explicit actions. Forgetting
removes only this computer's setting; it does not delete local portfolio data or shared snapshots.
Conflicts remain visible and require inspection outside the compact widget before resolution.

Synchronization and backup are deliberately separate. Synchronization exchanges path-neutral JSON
portfolio snapshots between computers. Automatic backup writes `pimpampum-latest.sqlite` for local
recovery and never acts as a merge transport.

## Service controls

The final card in **Settings** shows whether the Pimpampum daemon is running. **Restart service**
restarts only the background daemon. **Stop Pimpampum…** requires confirmation and stops agents,
synchronization, and automatic backups without deleting local data or removing the widget. While
stopped, the same card exposes **Start Pimpampum**, so no launcher entry or terminal command is
required to recover.

## Remove

```bash
pimpampum uninstall
```

Removal uses the same receipt and lifecycle lock. It asks the bounded connection
helper to disconnect only entries whose connector receipts prove ownership, then
delegates service and plugin removal to the receipt-selected control launcher and
stages the receipt-owned runtime and launchers before deletion. Unknown entries
are left unchanged with redacted manual guidance. A mandatory late failure
restores completed owned routes and the prior service/runtime before returning an
error. Databases, tokens, backups, exports, and synchronization snapshots are
never removal targets. The pinned Quattro contract's
`listShellConfig` IPC method captures only this widget's section, index, and
inline settings before removal. If a later step fails, `enablePlugin` and
`setBarWidget` restore that exact entry without direct `shell.json` access or
changes to unrelated layout entries. The repository-local `uninstall.sh` is a
thin entry into that single bounded lifecycle; restarting Quickshell never calls
it and never stops the daemon.

## Validation

The packaged cross-platform validator can run on macOS or Linux:

```bash
npm run validate:omarchy
```

The following release workflow requires a full source checkout and is intentionally not included
in the published runtime tarball. On the target machine, run:

```bash
omarchy version
omarchy plugin validate ./integrations/omarchy/pimpampum-status
npm run build
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
npm run test:e2e:omarchy
```

Static validation does not prove live Quattro behavior. The live smoke is the
way to record that a human saw the widget on a real machine; since 2026-08-28
it is opt-in and not a release gate (see
`thoughts/notes/2026-08-28_quattro-gate-removed.md`). Whoever runs it must
directly observe this matrix:

- The same `assets/pimpampum-compact.svg` fixed circle-p identity, tinted with
  the inherited foreground, in every state. Only the external accent and shape
  communicate state; offline, credentials, and incompatible states never
  replace the mark with an x, exclamation mark, or network glyph.
- Horizontal side-by-side and vertical stacked bar layouts, with counts `7`,
  `42`, and `99+`; zero is hidden and negative input is clamped to zero.
- Light and dark themes; complete, available, active/draft, empty, offline,
  stale, and credentials states.
- Hover, visible keyboard focus, and activation where Quickshell supports them;
  bounded scrolling with a fixed footer, long-name disambiguation, in-progress Spec progress,
  completed-Spec expansion/collapse, safe workspace opening, Help, and Quit/Start.
- Backup unconfigured, healthy, backing-up, and failed presentations; native folder selection;
  destination preview; explicit enable/disable confirmation; and serialized configure, retry, and
  disable actions.
- Synchronization unconfigured, healthy, pending, paused, unavailable, failed, and conflicted
  presentations; provider-location selection and effective
  `Pimpampum` destination preview; explicit enable/forget confirmation; device identity, timestamps,
  pending count, open-folder, sync-now, and pause/resume actions. If the native picker dependency is
  unavailable, the UI points to the bounded CLI instead of exposing a duplicate path form.

Three presentations are deliberately not part of the live matrix, because a healthy
installation cannot show them: `incompatible` requires an overview `schemaVersion` other than 2,
which the daemon never emits; `importing` and `exporting` are set and cleared inside one local
filesystem operation, so a poll sees them only by chance. All three stay covered by automated
tests, and the runner prints this exclusion in the review prompt and hashes it into the approval
binding so the evidence records exactly what was and was not observed.

Use only supported Omarchy controls to change bar position or theme, and restore
the original selection before the runner continues. Do not edit `shell.json` or
QML to manufacture a state. Exercise data-backed states through Pimpampum's
public CLI/API only. If any matrix item was not actually observed, the reviewer
must decline approval rather than infer it from static validation.

The schema-v2 artifact remains deliberately stable: five canonical screenshots
bind the active popout, completed collapse, stale/offline state, recovery, and
workspace opening to their command transcript and hashes. The broader matrix is
included in the approval binding and interactive review prompt without adding
unverifiable authored flags or breaking existing evidence consumers.

The live runner is destructive only to the temporary Pimpampum installation it
creates. It refuses to run over an existing installation, records exact
argument-array transcripts, and emits no passing evidence unless uninstall
restores the captured baseline. The visual phase remains human-owned; the named
reviewer inspects the staged captures and directly exercises the matrix above.

When `quattro-live.json` exists it must have been generated by the exact opt-in workflow above
from a full checkout on the target machine, and `npm run check:quattro-evidence` verifies it.
Fixtures, static validation, failure transcripts, and `quattro-live.example.json` are not live
evidence. The release workflow does not require the file.
